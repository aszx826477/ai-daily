/**
 * AI日报系统 - 日报生成入口 v1.4
 * 基于来源分类生成日报
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import MarkdownIt from 'markdown-it';
import { fetchRSS, fetchWeb } from './fetcher.js';
import { formatShanghaiArticleDate, formatShanghaiDate, formatShanghaiDisplayDate } from './timezone.js';
import { getCurrentLogFile, initializeRunLogger, log } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.dirname(__dirname);

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

const defaultLinkOpenRenderer = markdownRenderer.renderer.rules.link_open
  || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

markdownRenderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpenRenderer(tokens, idx, options, env, self);
};

function loadConfig() {
  return {
    sources: JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config', 'sources.json'), 'utf-8')),
    settings: JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config', 'settings.json'), 'utf-8'))
  };
}

async function fetchAllContent(config) {
  const allArticles = [];
  for (const [categoryId, category] of Object.entries(config.sources.categories)) {
    if (!category.enabled) continue;
    log.info(`\n📊 抓取分类: ${category.name}`);
    for (const source of category.sources) {
      if (!source.enabled) continue;
      try {
        let articles = [];
        switch (source.type) {
          case 'rss': articles = await fetchRSS(source, category.keywords, config.settings); break;
          case 'web': articles = await fetchWeb(source, category.keywords, config.settings); break;
          default:
            log.warn(`[${source.name}] 跳过未支持的抓取类型: ${source.type}`);
        }
        articles = articles.map(a => ({ ...a, categoryId, categoryName: category.name }));
        allArticles.push(...articles);
        log.success(`[${source.name}] 共获取 ${articles.length} 条资讯`);
      } catch (error) {
        log.error(`[${source.name}] 抓取失败: ${error.message}`);
      }
    }
  }
  return allArticles;
}

function deduplicate(articles) {
  const seen = new Map();
  return articles.filter(a => {
    const key = a.title.toLowerCase().substring(0, 50);
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

function buildSourceConfigIndex(config) {
  const index = new Map();
  for (const category of Object.values(config.sources.categories)) {
    for (const source of category.sources || []) {
      if (!index.has(source.name)) index.set(source.name, source);
    }
  }
  return index;
}

function getSourceSelectionWeight(sourceConfig, globalSettings) {
  const configuredWeights = globalSettings?.sourcePriorityWeights || {};
  const defaultWeights = { high: 1.2, medium: 1.0, low: 0.8 };
  const priority = sourceConfig?.priority;
  const configuredWeight = configuredWeights[priority];

  if (typeof configuredWeight === 'number' && configuredWeight > 0) {
    return configuredWeight;
  }

  return defaultWeights[priority] || 1;
}

function getSelectionSettings(config) {
  const sourceSettings = config.sources.globalSettings || {};
  const reportSettings = config.settings.report || {};

  return {
    minRelevanceScore: reportSettings.minRelevanceScore ?? sourceSettings.minRelevanceScore ?? 0.3,
    maxArticlesPerCategory: sourceSettings.maxArticlesPerCategory ?? 30,
    maxTotalArticles: reportSettings.maxTotalArticles ?? Number.MAX_SAFE_INTEGER,
    highQualityThreshold: reportSettings.highQualityThreshold ?? sourceSettings.highQualityThreshold ?? 0.7,
    topHighlightsCount: reportSettings.topHighlightsCount ?? 5,
    sourcePriorityWeights: {
      high: 1.2,
      medium: 1.0,
      low: 0.8,
      ...(sourceSettings.sourcePriorityWeights || {}),
      ...(reportSettings.sourcePriorityWeights || {})
    },
    categoryWeights: reportSettings.categoryWeights || {}
  };
}

function getCategorySelectionWeight(categoryId, selectionSettings) {
  const configuredWeight = selectionSettings?.categoryWeights?.[categoryId];
  return typeof configuredWeight === 'number' && configuredWeight > 0 ? configuredWeight : 1;
}

function calculateWeightedCaps(maxArticles, entries) {
  if (maxArticles <= 0 || entries.length === 0) {
    return new Map();
  }

  const weightedEntries = entries
    .filter((entry) => entry.limit > 0)
    .map((entry) => ({
      ...entry,
      weight: typeof entry.weight === 'number' && entry.weight > 0 ? entry.weight : 1
    }))
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id, 'zh-CN'));

  const caps = new Map();
  weightedEntries.forEach((entry) => caps.set(entry.id, 0));

  for (let slot = 0; slot < maxArticles; slot++) {
    let bestEntry = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const entry of weightedEntries) {
      const currentCount = caps.get(entry.id) || 0;
      if (currentCount >= entry.limit) continue;

      const score = entry.weight / (currentCount + 1);
      if (
        score > bestScore ||
        (score === bestScore && bestEntry && entry.weight > bestEntry.weight) ||
        (score === bestScore && bestEntry && entry.weight === bestEntry.weight && entry.id.localeCompare(bestEntry.id, 'zh-CN') < 0) ||
        (score === bestScore && !bestEntry)
      ) {
        bestEntry = entry;
        bestScore = score;
      }
    }

    if (!bestEntry) break;
    caps.set(bestEntry.id, (caps.get(bestEntry.id) || 0) + 1);
  }

  return caps;
}

function calculateSourceCaps(maxArticles, sourceNames, sourceConfigs, globalSettings, availableCounts = new Map()) {
  return calculateWeightedCaps(
    maxArticles,
    sourceNames.map((sourceName) => ({
      id: sourceName,
      weight: getSourceSelectionWeight(sourceConfigs.get(sourceName), globalSettings),
      limit: availableCounts.get(sourceName) ?? maxArticles
    }))
  );
}

function getArticleTimestamp(article) {
  const timestamp = Date.parse(article.pubDate || '');
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getPriorityValue(priority) {
  return { high: 3, medium: 2, low: 1 }[priority] || 1;
}

function scoreArticle(article, selectionSettings) {
  const relevanceScore = Number(article.relevanceScore) || 0;
  const sourceWeight = getSourceSelectionWeight({ priority: article.sourcePriority }, selectionSettings);
  const categoryWeight = getCategorySelectionWeight(article._finalCatId || article.categoryId, selectionSettings);
  const priorityValue = getPriorityValue(article.sourcePriority);
  const freshnessBoost = getArticleTimestamp(article) / 1e14;

  return (relevanceScore * 100) + (categoryWeight * 10) + (sourceWeight * 5) + priorityValue + freshnessBoost;
}

function compareArticles(a, b, selectionSettings) {
  const scoreDiff = scoreArticle(b, selectionSettings) - scoreArticle(a, selectionSettings);
  if (scoreDiff !== 0) return scoreDiff;

  const timeDiff = getArticleTimestamp(b) - getArticleTimestamp(a);
  if (timeDiff !== 0) return timeDiff;

  return (a.title || '').localeCompare(b.title || '', 'zh-CN');
}

function processArticles(articles, config) {
  const s = getSelectionSettings(config);
  let processed = deduplicate(articles);
  log.success(`去重后: ${processed.length} 条`);
  processed = processed.filter(a => a.relevanceScore >= s.minRelevanceScore);

  for (const article of processed) {
    article._finalCatId = article.categoryId;
    article._finalCatName = article.categoryName || config.sources.categories[article.categoryId]?.name || article.categoryId;
  }

  processed.sort((a, b) => compareArticles(a, b, s));

  const sourceConfigIndex = buildSourceConfigIndex(config);
  const groupedByCategory = {};
  for (const article of processed) {
    const catId = article._finalCatId || article.categoryId;
    if (!groupedByCategory[catId]) groupedByCategory[catId] = [];
    groupedByCategory[catId].push(article);
  }

  const categoryCaps = calculateWeightedCaps(
    s.maxTotalArticles,
    Object.entries(groupedByCategory).map(([catId, categoryArticles]) => ({
      id: catId,
      weight: getCategorySelectionWeight(catId, s),
      limit: Math.min(s.maxArticlesPerCategory, categoryArticles.length)
    }))
  );

  const result = {};
  for (const [catId, categoryArticles] of Object.entries(groupedByCategory)) {
    const categoryCap = categoryCaps.get(catId) || 0;
    if (categoryCap <= 0) continue;

    const categorySourceConfigs = new Map(
      (config.sources.categories[catId]?.sources || []).map(source => [source.name, source])
    );
    const sourceNames = [...new Set(categoryArticles.map(article => article.source))];
    const availableCounts = categoryArticles.reduce((counts, article) => {
      counts.set(article.source, (counts.get(article.source) || 0) + 1);
      return counts;
    }, new Map());
    const sourceConfigs = new Map(
      sourceNames.map(sourceName => [sourceName, categorySourceConfigs.get(sourceName) || sourceConfigIndex.get(sourceName) || null])
    );
    const sourceCaps = calculateSourceCaps(categoryCap, sourceNames, sourceConfigs, s, availableCounts);
    const selected = [];
    const skipped = [];
    const sourceCounts = new Map();

    for (const article of categoryArticles) {
      const currentCount = sourceCounts.get(article.source) || 0;
      const sourceCap = sourceCaps.get(article.source) ?? categoryCap;

      if (selected.length < categoryCap && currentCount < sourceCap) {
        selected.push(article);
        sourceCounts.set(article.source, currentCount + 1);
      } else {
        skipped.push(article);
      }
    }

    for (const article of skipped) {
      if (selected.length >= categoryCap) break;
      selected.push(article);
    }

    if (selected.length > 0) {
      result[catId] = selected.sort((a, b) => compareArticles(a, b, s));
    }
  }

  const topHighlights = Object.values(result)
    .flat()
    .sort((a, b) => compareArticles(a, b, s))
    .slice(0, s.topHighlightsCount);

  return { articlesByCategory: result, topHighlights, selectionSettings: s };
}

function generateStats(articles, allArticles, selectionSettings, topHighlights) {
  const stats = {
    totalArticles: 0,
    totalFetched: allArticles.length,
    highQualityCount: 0,
    byCategory: {},
    bySource: {},
    maxTotalArticles: selectionSettings.maxTotalArticles,
    maxArticlesPerCategory: selectionSettings.maxArticlesPerCategory,
    topHighlightsCount: topHighlights.length
  };
  for (const [catId, catArticles] of Object.entries(articles)) {
    stats.totalArticles += catArticles.length;
    stats.byCategory[catId] = catArticles.length;
    for (const a of catArticles) {
      stats.bySource[a.source] = (stats.bySource[a.source] || 0) + 1;
      if (a.relevanceScore >= selectionSettings.highQualityThreshold) stats.highQualityCount++;
    }
  }
  return stats;
}

function generateSourceDist(articles) {
  const dist = {};
  for (const [, catArticles] of Object.entries(articles)) {
    for (const a of catArticles) dist[a.source] = (dist[a.source] || 0) + 1;
  }
  return Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([source, count]) => ({ source, count }));
}

const CATEGORY_META = {
  ai_tech: { color: '#667eea', icon: '🚀' },
  shenzhen_real_estate: { color: '#ed8936', icon: '🏠' },
  war_situation: { color: '#e53e3e', icon: '🛡️' },
  medical_health: { color: '#38b2ac', icon: '💚' }
};

function getCategoryMeta(catId) {
  return CATEGORY_META[catId] || { color: '#888', icon: '📋' };
}

function generateCategoryDist(articles) {
  return Object.entries(articles).map(([catId, catArticles]) => ({
    name: catArticles[0]?._finalCatName || catArticles[0]?.categoryName || catId,
    count: catArticles.length,
    color: getCategoryMeta(catId).color,
    icon: getCategoryMeta(catId).icon,
  }));
}

function escapeHTML(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdownToHTML(markdown) {
  if (!markdown) return '';

  const normalized = markdown.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  return markdownRenderer.render(normalized);
}

function formatOptionalArticleDate(dateInput) {
  if (!dateInput) return '发布时间未标注';
  const parsedDate = new Date(dateInput);
  if (Number.isNaN(parsedDate.getTime())) return '发布时间未标注';
  return formatShanghaiArticleDate(parsedDate);
}

function decodeHTMLEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([\da-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHTML(value) {
  return decodeHTMLEntities(
    String(value || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractMetaContent(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHTMLEntities(match[1]).trim();
  }
  return '';
}

function cleanArticleHTML(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(header|footer|nav|form|button|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

function htmlToStructuredText(html) {
  return decodeHTMLEntities(
    cleanArticleHTML(html)
      .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n\n')
      .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n\n')
      .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n\n')
      .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n\n')
      .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
      .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n')
      .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
      .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, '\n````\n$1\n````\n')
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractArticleContent(html, url) {
  const cleanedHTML = cleanArticleHTML(html);
  const title = extractMetaContent(cleanedHTML, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    /<title[^>]*>([^<]+)<\/title>/i
  ]);

  const description = extractMetaContent(cleanedHTML, [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i
  ]);

  const publishedAt = extractMetaContent(cleanedHTML, [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<time[^>]+datetime=["']([^"']+)["']/i
  ]);

  const candidateBlocks = [];
  const articlePatterns = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
    /<(section|div)\b[^>]*(?:class|id)=["'][^"']*(?:article|post|content|body|prose|markdown)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi
  ];

  for (const pattern of articlePatterns) {
    let match;
    while ((match = pattern.exec(cleanedHTML)) !== null) {
      const block = match[2] || match[1] || '';
      const text = htmlToStructuredText(block);
      if (text.length >= 600) {
        candidateBlocks.push(text);
      }
    }
  }

  if (candidateBlocks.length === 0) {
    candidateBlocks.push(htmlToStructuredText(cleanedHTML));
  }

  candidateBlocks.sort((a, b) => b.length - a.length);
  const content = candidateBlocks[0] || '';

  return {
    url,
    title: title.replace(/\s*[|-].*$/, '').trim() || url,
    description,
    publishedAt,
    content
  };
}

async function fetchDailyReadingArticle(dailyReadingConfig) {
  if (!dailyReadingConfig?.enabled || !dailyReadingConfig.url) return null;

  log.info(`\n📚 抓取每日精读文章: ${dailyReadingConfig.url}`);
  const response = await fetch(dailyReadingConfig.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    },
    timeout: 20000,
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`请求失败: HTTP ${response.status}`);
  }

  const html = await response.text();
  const article = extractArticleContent(html, dailyReadingConfig.url);
  if (!article.content || article.content.length < 800) {
    throw new Error('正文提取失败，文章内容不足');
  }

  article.configTitle = dailyReadingConfig.title || '';
  article.source = dailyReadingConfig.source || new URL(dailyReadingConfig.url).hostname;
  article.maxInputChars = dailyReadingConfig.maxInputChars || 18000;
  article.maxOutputTokens = dailyReadingConfig.maxOutputTokens || 2200;

  log.success(`每日精读正文提取成功: ${article.content.length} 字符`);
  return article;
}

function buildDailyReadingPrompt(article) {
  const articleText = article.content.slice(0, article.maxInputChars);
  return `你是一位擅长长文精读的研究编辑。请对下面这篇研究/工程文章进行“每日精读”，要求忠实还原原文论证结构与核心观点，不要脱离原文任意发挥，也不要写成流水账。

输出要求：
1. 使用中文输出。
2. 先给出“核心摘要”，控制在120字以内。
3. 再给出“文章结构”，按原文主要章节或论证推进列出3-6点。
4. 再给出“关键观点”，提炼4-6点，每点都要说明作者的主张、依据或例子。
5. 再给出“我的启发”，总结2-3点值得持续关注的趋势或方法。
6. 全文控制在700-1200字，既完整又凝练。
7. 如果原文存在时间线、实验结果、对比数据或版本迭代，请保留这些关键信息。
8. 使用 Markdown 输出，允许二级标题和项目符号。

文章标题：${article.title}
文章来源：${article.source}
文章链接：${article.url}
发布时间：${article.publishedAt || '未标注'}
原文摘要：${article.description || '无'}

原文正文：
${articleText}`;
}

async function generateDailyReading(dailyReadingConfig, settings) {
  const aiConfig = settings.ai;
  if (!dailyReadingConfig?.enabled || !dailyReadingConfig.url) return null;
  if (!aiConfig?.enabled) {
    log.warn('每日精读已启用，但 AI 配置未启用');
    return null;
  }

  try {
    const article = await fetchDailyReadingArticle(dailyReadingConfig);
    const client = new OpenAI({
      apiKey: aiConfig.apiKey,
      baseURL: aiConfig.baseURL,
    });

    log.info('\n🤖 调用 AI 生成每日精读...');
    const response = await client.chat.completions.create({
      model: aiConfig.model,
      messages: [{ role: 'user', content: buildDailyReadingPrompt(article) }],
      max_tokens: article.maxOutputTokens,
      temperature: 0.4,
    });

    const analysis = response.choices?.[0]?.message?.content?.trim();
    if (!analysis) {
      log.warn('每日精读返回内容为空');
      return null;
    }

    log.success('每日精读生成成功');
    return {
      title: article.configTitle || article.title,
      articleTitle: article.title,
      source: article.source,
      url: article.url,
      publishedAt: article.publishedAt,
      description: article.description,
      contentLength: article.content.length,
      inputChars: Math.min(article.content.length, article.maxInputChars),
      analysis,
    };
  } catch (error) {
    log.error(`每日精读生成失败: ${error.message}`);
    return null;
  }
}

// ========== AI 解读 ==========
async function generateAIInterpretation(articles, settings) {
  const aiConfig = settings.ai;
  if (!aiConfig?.enabled) return '';

  // 收集各分类的文章标题
  const headlines = [];
  for (const [, catArticles] of Object.entries(articles)) {
    for (const a of catArticles) {
      headlines.push(`[${a._finalCatName || a.categoryName}] ${a.title}`);
    }
  }
  if (headlines.length === 0) return '';

  const prompt = `你是一位资深的科技与时事分析师。以下是今日各领域的新闻标题列表，请对今日要闻进行简要解读和总结。要求：
1. 分领域概括当天核心动态，每个领域2-3句话
2. 最后用1-2句点评整体趋势
3. 总字数控制在300字以内，语言精炼，不要废话

今日新闻标题：
${headlines.join('\n')}`;

  try {
    const client = new OpenAI({
      apiKey: aiConfig.apiKey,
      baseURL: aiConfig.baseURL,
    });
    const response = await client.chat.completions.create({
      model: aiConfig.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: aiConfig.maxTokens || 1024,
      temperature: 0.7,
    });
    const content = response.choices?.[0]?.message?.content?.trim();
    if (content) {
      log.success('AI解读生成成功');
      return content;
    }
    log.warn('AI解读返回内容为空');
    return '';
  } catch (error) {
    log.error(`AI解读生成失败: ${error.message}`);
    return '';
  }
}

// ========== HTML 生成 ==========
const BAR_COLORS = ['#667eea','#38b2ac','#e53e3e','#dd6b20','#d69e2e','#805ad5','#3182ce','#48bb78'];

function generateHTML(data) {
  const { date, articles, stats, config, aiInterpretation, topHighlights, dailyReading } = data;
  const reportDate = date || formatShanghaiDate();
  const dateStr = formatShanghaiDisplayDate(reportDate);
  const sourceDist = generateSourceDist(articles);
  const categoryDist = generateCategoryDist(articles);
  const aiInterpretationHTML = renderMarkdownToHTML(aiInterpretation);
  const dailyReadingHTML = renderMarkdownToHTML(dailyReading?.analysis || '');

  const barHTML = categoryDist.map(cat =>
    `<div class="bar-row">
      <div class="bar-label">${cat.icon} ${cat.name}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${cat.count / stats.totalArticles * 100}%;background:${cat.color}"></div></div>
      <div class="bar-num">${cat.count}</div>
    </div>`
  ).join('');

  const srcBarHTML = sourceDist.map((item, i) =>
    `<div class="sb-row">
      <div class="sb-name" title="${item.source}">${item.source}</div>
      <div class="sb-track"><div class="sb-fill" style="width:${sourceDist[0] ? item.count / sourceDist[0].count * 100 : 0}%;background:${BAR_COLORS[i % BAR_COLORS.length]}"></div></div>
      <div class="sb-count">${item.count}条</div>
    </div>`
  ).join('');

  const topHighlightsHTML = topHighlights.map((article, index) => `
    <div class="top-item">
      <div class="top-rank">TOP ${index + 1}</div>
      <div class="top-main">
        <div class="top-title"><a href="${article.link}" target="_blank">${article.title}</a></div>
        <div class="top-meta">
          <span class="article-source">${article._finalCatName || article.categoryName}</span>
          <span style="margin-left:10px">${article.source}</span>
          <span style="margin-left:10px">${formatShanghaiArticleDate(article.pubDate)}</span>
        </div>
        <div class="article-summary">${article.summary}</div>
      </div>
    </div>`).join('');

  let keywordsHTML = '';
  for (const [catId, category] of Object.entries(config.sources.categories)) {
    if (!category.enabled) continue;
    const { icon, color: borderColor } = getCategoryMeta(catId);
    const enabledSources = category.sources.filter(s => s.enabled).map(s => s.name);
    keywordsHTML += `
    <div class="kw-category">
      <div class="kw-cat-header" style="border-left:3px solid ${borderColor}">
        <span class="kw-cat-icon">${icon}</span>
        <span class="kw-cat-name">${category.name}</span>
        <span class="kw-cat-count">${enabledSources.length}个信息源</span>
      </div>
      <div class="kw-tags">${category.keywords.slice(0,30).map(k => `<span class="kw-tag">${k}</span>`).join('')}</div>
      <div class="kw-sources">信息源: ${enabledSources.join(' · ') || '暂无'}</div>
    </div>`;
  }

  let sectionsHTML = '';
  for (const [catId, catArticles] of Object.entries(articles)) {
    const catName = catArticles[0]?._finalCatName || catArticles[0]?.categoryName || catId;
    const { icon, color: borderCol } = getCategoryMeta(catId);
    let articleListHTML = '';
    for (const a of catArticles) {
      const qBadge = a.relevanceScore >= 0.7 ? '<span class="quality-badge quality-high">高质量</span>' : '';
      const ghMeta = a.stars ? `<div class="github-meta">⭐ ${a.stars.toLocaleString()} | ${a.language || ''}</div>` : '';
      const authors = a.authors ? `<div class="authors">作者: ${a.authors}</div>` : '';
      articleListHTML += `
        <div class="article">
          <div class="article-title"><a href="${a.link}" target="_blank">${a.title}</a>${qBadge}</div>
          <div class="article-meta">
            <span class="article-source">${a.source}</span>
            <span style="margin-left:10px">${formatShanghaiArticleDate(a.pubDate)}</span>
          </div>
          <div class="article-summary">${a.summary}</div>
          ${authors}${ghMeta}
        </div>`;
    }
    sectionsHTML += `
    <div class="section">
      <h2 class="section-title" style="border-color:${borderCol}">${icon} ${catName} <span style="font-size:0.5em;opacity:0.6;vertical-align:middle">${catArticles.length}条</span></h2>
      ${articleListHTML}
    </div>`;
  }

  const dailyReadingSectionHTML = dailyReading && dailyReadingHTML ? `
  <div class="daily-reading-section">
    <div class="daily-reading-title">📖 每日精读</div>
    <div class="daily-reading-card">
      <div class="daily-reading-head">
        <div>
          <div class="daily-reading-article-title"><a href="${dailyReading.url}" target="_blank" rel="noopener noreferrer">${escapeHTML(dailyReading.articleTitle || dailyReading.title || '原文链接')}</a></div>
          <div class="daily-reading-meta">
            <span>${escapeHTML(dailyReading.source || '')}</span>
            <span>${escapeHTML(formatOptionalArticleDate(dailyReading.publishedAt))}</span>
            <span>正文约 ${dailyReading.contentLength || dailyReading.inputChars || 0} 字符</span>
          </div>
        </div>
        <a class="daily-reading-link" href="${dailyReading.url}" target="_blank" rel="noopener noreferrer">查看原文</a>
      </div>
      ${dailyReading.description ? `<div class="daily-reading-desc">${escapeHTML(dailyReading.description)}</div>` : ''}
      <div class="daily-reading-content">${dailyReadingHTML}</div>
      <div class="daily-reading-footer">基于 ${escapeHTML(config.settings.ai.model)} 自动精读，强调结构还原与观点浓缩</div>
    </div>
  </div>` : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AI日报 - ${reportDate}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6;color:#333;background:#f0f2f5}
.container{max-width:860px;margin:0 auto;padding:16px}
.header{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:36px 24px;text-align:center;border-radius:14px;margin-bottom:24px}
.header h1{font-size:2.2em;margin-bottom:6px}
.header .date{font-size:1.05em;opacity:.9}
.header-stats{display:flex;justify-content:center;gap:36px;margin-top:22px}
.hs-item{text-align:center}
.hs-val{font-size:2em;font-weight:700}
.hs-label{font-size:.85em;opacity:.85}
.dashboard{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
@media(max-width:640px){.dashboard{grid-template-columns:1fr}}
.dash-card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 6px rgba(0,0,0,.04)}
.dash-title{font-size:.95em;font-weight:600;color:#555;margin-bottom:14px}
.bar-section{display:flex;flex-direction:column;gap:12px}
.bar-row{display:flex;align-items:center;gap:10px}
.bar-label{width:120px;font-size:.82em;color:#555;text-align:right}
.bar-track{flex:1;height:24px;background:#f0f2f5;border-radius:6px}
.bar-fill{height:100%;border-radius:6px;min-width:4px}
.bar-num{width:30px;font-size:.9em;font-weight:600}
.source-bars{grid-column:1/-1}
.sb-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.sb-name{width:130px;font-size:.78em;color:#666;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-track{flex:1;height:18px;background:#f0f2f5;border-radius:4px}
.sb-fill{height:100%;border-radius:4px;min-width:3px}
.sb-count{width:50px;font-size:.75em;color:#888;text-align:right}
.kw-section{grid-column:1/-1}
.kw-category{margin-bottom:16px}
.kw-cat-header{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f8f9fa;border-radius:8px 8px 0 0}
.kw-cat-name{font-weight:600;font-size:.95em}
.kw-cat-count{margin-left:auto;font-size:.78em;color:#999;background:#e9ecef;padding:1px 8px;border-radius:10px}
.kw-tags{display:flex;flex-wrap:wrap;gap:6px;padding:12px;background:#fff;border:1px solid #f0f0f0;border-top:none;border-radius:0 0 8px 8px}
.kw-tag{display:inline-block;padding:3px 10px;background:linear-gradient(135deg,#f0f2ff,#e8ecff);color:#555;border-radius:14px;font-size:.78em}
.kw-sources{margin-top:8px;font-size:.78em;color:#aaa}
.section{background:#fff;border-radius:12px;padding:22px;margin-bottom:18px;box-shadow:0 1px 6px rgba(0,0,0,.04)}
.section-title{font-size:1.3em;color:#333;margin-bottom:18px;padding-bottom:10px;border-bottom:2px solid #667eea}
.article{padding:14px 0;border-bottom:1px solid #f0f0f0}
.article:last-child{border-bottom:none}
.article-title{font-size:1.05em;color:#333;margin-bottom:6px}
.article-title a{color:#667eea;text-decoration:none}
.article-title a:hover{text-decoration:underline}
.article-meta{font-size:.82em;color:#999;margin-bottom:6px}
.article-source{background:#f0f2ff;padding:2px 8px;border-radius:4px;font-weight:500;color:#667eea}
.article-summary{color:#555;font-size:.92em}
.quality-badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:.72em;margin-left:6px}
.quality-high{background:#d4edda;color:#155724}
.github-meta,.authors{font-size:.82em;color:#888;margin-top:4px}
.footer{text-align:center;padding:28px;color:#aaa;font-size:.85em}
.ai-section{background:linear-gradient(135deg,#f8f9ff 0%,#f0f4ff 100%);border:1px solid #e0e6ff;border-radius:12px;padding:22px 24px;margin-bottom:24px;position:relative;overflow:hidden}
.ai-section::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#667eea,#764ba2,#667eea)}
.ai-title{font-size:1.1em;font-weight:600;color:#4a5568;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.ai-content{font-size:.92em;color:#555;line-height:1.85}
.ai-content p{margin:0 0 12px}
.ai-content p:last-child{margin-bottom:0}
.ai-content strong{color:#2d3748;font-weight:700}
.ai-content em{font-style:italic}
.ai-content code{font-family:'Consolas','SFMono-Regular',monospace;background:#edf2ff;color:#4c51bf;padding:1px 6px;border-radius:4px}
.ai-content ul,.ai-content ol{margin:0 0 12px 22px}
.ai-content li{margin-bottom:6px}
.ai-content a{color:#4c51bf;text-decoration:none}
.ai-content a:hover{text-decoration:underline}
.ai-footer{margin-top:12px;font-size:.75em;color:#aaa;text-align:right}
.top-section{background:linear-gradient(135deg,#fffaf0 0%,#fff3db 100%);border:1px solid #f6d8a8;border-radius:12px;padding:22px 24px;margin-bottom:24px}
.top-title{font-size:1.1em;font-weight:700;color:#8c5a00;margin-bottom:14px}
.top-list{display:flex;flex-direction:column;gap:14px}
.top-item{display:flex;gap:14px;padding:14px 0;border-top:1px solid rgba(140,90,0,.1)}
.top-item:first-child{border-top:none;padding-top:0}
.top-rank{min-width:64px;height:30px;border-radius:999px;background:#8c5a00;color:#fff;font-size:.78em;font-weight:700;display:flex;align-items:center;justify-content:center}
.top-main{flex:1}
.top-main .top-title{font-size:1.02em;font-weight:600;color:#2d3748;margin-bottom:6px}
.top-main .top-title a{color:#8c5a00;text-decoration:none}
.top-main .top-title a:hover{text-decoration:underline}
.daily-reading-section{background:linear-gradient(135deg,#f5fbf7 0%,#eef8ff 100%);border:1px solid #cfe7da;border-radius:12px;padding:22px 24px;margin-bottom:24px}
.daily-reading-title{font-size:1.14em;font-weight:700;color:#21543d;margin-bottom:14px}
.daily-reading-card{background:rgba(255,255,255,.82);border:1px solid rgba(33,84,61,.1);border-radius:12px;padding:18px 18px 16px;backdrop-filter:blur(4px)}
.daily-reading-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:12px}
.daily-reading-article-title{font-size:1.04em;font-weight:600;line-height:1.5}
.daily-reading-article-title a{color:#21543d;text-decoration:none}
.daily-reading-article-title a:hover{text-decoration:underline}
.daily-reading-meta{display:flex;flex-wrap:wrap;gap:8px 14px;font-size:.8em;color:#5f7a6d;margin-top:6px}
.daily-reading-link{display:inline-flex;align-items:center;justify-content:center;padding:8px 12px;background:#21543d;color:#fff;border-radius:999px;text-decoration:none;font-size:.82em;white-space:nowrap}
.daily-reading-link:hover{background:#173b2b}
.daily-reading-desc{font-size:.86em;color:#5c6b63;background:#f6fbf8;border-radius:8px;padding:10px 12px;margin-bottom:14px}
.daily-reading-content{font-size:.93em;color:#33423b;line-height:1.9}
.daily-reading-content p{margin:0 0 12px}
.daily-reading-content p:last-child{margin-bottom:0}
.daily-reading-content strong{color:#173b2b}
.daily-reading-content code{font-family:'Consolas','SFMono-Regular',monospace;background:#e6f4ec;color:#21543d;padding:1px 6px;border-radius:4px}
.daily-reading-content ul,.daily-reading-content ol{margin:0 0 12px 22px}
.daily-reading-content li{margin-bottom:6px}
.daily-reading-content a{color:#21543d}
.daily-reading-footer{margin-top:12px;font-size:.76em;color:#7c9086;text-align:right}
@media(max-width:640px){.daily-reading-head{flex-direction:column}.daily-reading-link{width:100%}}
@media(max-width:640px){.top-item{flex-direction:column;gap:8px}.top-rank{min-width:auto;width:72px}}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>AI日报</h1>
    <div class="date">${dateStr}</div>
    <div class="header-stats">
      <div class="hs-item"><div class="hs-val">${stats.totalArticles}</div><div class="hs-label">资讯收录</div></div>
      <div class="hs-item"><div class="hs-val">${stats.highQualityCount}</div><div class="hs-label">高质量</div></div>
      <div class="hs-item"><div class="hs-val">${Object.keys(stats.bySource).length}</div><div class="hs-label">信息源</div></div>
      <div class="hs-item"><div class="hs-val">${categoryDist.length}</div><div class="hs-label">分类</div></div>
    </div>
  </div>
  ${aiInterpretationHTML ? `<div class="ai-section">
    <div class="ai-title">🧠 AI 今日要闻解读</div>
    <div class="ai-content">${aiInterpretationHTML}</div>
    <div class="ai-footer">由 AI 大模型自动生成</div>
  </div>` : ''}
  ${topHighlights.length > 0 ? `<div class="top-section">
    <div class="top-title">⭐ TOP${topHighlights.length} 今日最值得关注</div>
    <div class="top-list">${topHighlightsHTML}</div>
  </div>` : ''}
  <div class="dashboard">
    <div class="dash-card"><div class="dash-title">📈 分类统计</div><div class="bar-section">${barHTML}</div></div>
    <div class="dash-card"><div class="dash-title">📰 来源贡献量</div><div style="max-height:260px;overflow-y:auto">${srcBarHTML}</div></div>
    <div class="dash-card kw-section">
      <div class="dash-title">🔑 抓取关键词配置</div>
      <p style="font-size:.82em;color:#999;margin-bottom:14px">以下关键词用于信息检索和相关性匹配</p>
      ${keywordsHTML}
    </div>
  </div>
  ${sectionsHTML}
  ${dailyReadingSectionHTML}
  <div class="footer">
    <p>AI日报系统 自动生成</p>
    <p style="margin-top:8px;font-size:.82em">配置文件: config/sources.json | 定时发送: 每天 09:00</p>
  </div>
</div>
</body>
</html>`;
}

// ========== Main ==========
async function main() {
  const config = loadConfig();
  const logFile = initializeRunLogger(config.settings);
  log.info('🚀 AI日报系统启动');
  log.info('='.repeat(50));
  log.info(`日志文件: ${logFile}`);
  log.info(`抓取时效性: 最近 ${config.settings?.fetch?.freshnessDays || 2} 天`);
  const startTime = Date.now();
  try {
    log.info('\n📡 开始抓取内容...');
    const allArticles = await fetchAllContent(config);
    log.success(`总计抓取: ${allArticles.length} 条资讯`);

    log.info('\n📊 进行数据统计分析...');
  const { articlesByCategory: articles, topHighlights, selectionSettings } = processArticles(allArticles, config);
  const stats = generateStats(articles, allArticles, selectionSettings, topHighlights);
    log.success(`总计收录: ${stats.totalArticles} 条资讯`);
    log.success(`高质量: ${stats.highQualityCount} 条`);
    log.success(`信息源: ${Object.keys(stats.bySource).length} 个`);
    log.success(`分类: ${Object.keys(articles).join(', ')}`);
  log.success(`TOP资讯: ${topHighlights.length} 条`);

    log.info('\n📝 生成日报HTML...');
    const date = formatShanghaiDate();

    log.info('\n🧠 调用AI大模型生成今日解读...');
    const aiInterpretation = await generateAIInterpretation(articles, config.settings);

    const dailyReading = await generateDailyReading(config.sources.dailyReading, config.settings);

    const html = generateHTML({ date, articles, stats, config, aiInterpretation, topHighlights, dailyReading });

    const outputDir = path.join(ROOT_DIR, 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const filepath = path.join(outputDir, `daily-report-${date}.html`);
    fs.writeFileSync(filepath, html, 'utf-8');
    log.success(`HTML已保存: ${filepath}`);

    const jsonFile = path.join(outputDir, `daily-report-${date}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify({ date, articles, topHighlights, stats, dailyReading }, null, 2), 'utf-8');
    log.success(`JSON已保存: ${jsonFile}`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    log.success(`\n✅ 日报生成完成，耗时 ${elapsed}s`);
    return { date, filepath, stats, articles, topHighlights, dailyReading, logFile: getCurrentLogFile() };
  } catch (error) {
    log.error('日报生成失败:', error);
    throw error;
  }
}

export { main as generateDaily, generateHTML };
export default main;

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  main().catch((error) => {
    log.error('日报脚本执行失败:', error);
    process.exitCode = 1;
  });
}
