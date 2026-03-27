/**
 * AI日报系统 - 数据抓取模块 v1.6
 * 支持 RSS 和 Web 两种抓取方式
 */

import RSSParser from 'rss-parser';
import fetch from 'node-fetch';
import { getShanghaiDateKey } from './timezone.js';
import { log } from './logger.js';
import { getFreshnessDays, isWithinFreshnessWindow } from './time-window.js';

const rssParser = new RSSParser({
  timeout: 10000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
});

// RSS源抓取
export async function fetchRSS(source, keywords, settings = {}) {
  const { url, name } = source;
  const freshnessDays = getFreshnessDays(settings);
  log.info(`[RSS] 抓取: ${name}`);
  try {
    const feed = await rssParser.parseURL(url);
    const articles = [];
    
    for (const item of feed.items.slice(0, 20)) {
      const title = item.title || '';
      const content = item.content || item['content:encoded'] || item.summary || '';
      
      const pubDate = item.pubDate || item.isoDate || new Date().toISOString();
      if (!isWithinFreshnessWindow(pubDate, freshnessDays)) continue;
      
      const relevance = calculateRelevance(title, content, keywords);
      if (relevance >= 0.2) {
        articles.push({
          title, link: item.link || item.guid || '',
          pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
          summary: extractSummary(content, 200),
          source: name, sourcePriority: source.priority,
          relevanceScore: relevance,
          author: item.author || item.creator || ''
        });
      }
    }
    return articles;
  } catch (error) {
    log.error(`[RSS] ${name} 抓取失败: ${error.message}`);
    return [];
  }
}

// Web源抓取（从网站提取链接）
export async function fetchWeb(source, keywords, settings = {}) {
  log.info(`[Web] 抓取: ${source.name}`);
  try {
    const freshnessDays = getFreshnessDays(settings);
    const res = await fetch(source.url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeout: 15000,
      redirect: 'follow'
    });
    
    const html = await res.text();
    const articles = [];
    
    // 提取链接
    const linkPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{4,80})<\/a>/gi;
    let match;
    const seen = new Set();
    
    while ((match = linkPattern.exec(html)) !== null) {
      let link = match[1];
      let title = match[2].replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' ');
      
      if (!title || title.length < 6) continue;
      if (title.includes('登录') || title.includes('注册') || title.includes('404')) continue;
      
      // 补全链接
      if (link.startsWith('/')) {
        try {
          const base = new URL(source.url);
          link = base.origin + link;
        } catch {}
      }
      
      if (!link.startsWith('http')) continue;
      if (link.includes('javascript:') || link.includes('#')) continue;
      
      // 去重
      const key = title.substring(0, 20);
      if (seen.has(key)) continue;
      seen.add(key);
      
      // 检查URL或标题中是否包含今天的日期
      const dateInUrl = link.match(/202[0-9]-[01][0-9]-[0-3][0-9]/);
      const dateInTitle = title.match(/202[0-9]-[01][0-9]-[0-3][0-9]/);
      const articleDate = dateInUrl?.[0] || dateInTitle?.[0];
      
      // 如果有日期信息，只保留时效窗口内的内容
      if (articleDate && !isWithinFreshnessWindow(articleDate, freshnessDays)) continue;
      
      // 关键词匹配
      const titleLower = title.toLowerCase();
      const hasKeyword = keywords.some(k => titleLower.includes(k.toLowerCase()));
      if (!hasKeyword) continue;
      
      // 计算相关性
      let matchCount = 0;
      for (const kw of keywords) {
        if (titleLower.includes(kw.toLowerCase())) matchCount++;
      }
      const relevance = Math.min(0.3 + matchCount * 0.15, 1.0);
      
      articles.push({
        title,
        link,
        source: source.name,
        sourcePriority: source.priority,
        relevanceScore: relevance,
        pubDate: new Date().toISOString(),
        summary: ''
      });
    }
    
    log.success(`[${source.name}] 共获取 ${articles.length} 条`);
    return articles;
  } catch (error) {
    log.error(`[Web] ${source.name} 抓取失败: ${error.message}`);
    return [];
  }
}

// 计算相关性分数
function calculateRelevance(title, summary, keywords) {
  const text = `${title} ${summary}`.toLowerCase();
  let totalWeight = 0, matchCount = 0;
  for (const keyword of keywords) {
    const kw = keyword.toLowerCase();
    if (text.includes(kw)) {
      matchCount++;
      totalWeight += title.toLowerCase().includes(kw) ? 0.15 : 0.08;
    }
  }
  return Math.min(0.2 + totalWeight + (matchCount * 0.05), 1.0);
}

// 提取摘要
function extractSummary(content, maxLength = 200) {
  if (!content) return '';
  const text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const truncated = text.substring(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('。');
  return (lastPeriod > maxLength * 0.7) ? truncated.substring(0, lastPeriod + 1) : truncated + '...';
}

export default { fetchRSS, fetchWeb };
