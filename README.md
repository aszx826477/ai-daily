# AI 日报系统

自动抓取多分类资讯，生成 HTML 日报并通过邮件发送。当前聚焦中文 RSS 和网页抓取场景，支持统一时区处理、按关键词相关性重分类，以及按信息源优先级控制分类内的来源分布。

同时支持“每日精读”：从指定长文章 URL 抓取正文，调用大模型生成结构化深读摘要，并追加到日报底部。

## 当前能力

- 真实抓取：仅保留 RSS 和 Web 两种抓取方式
- 智能筛选：基于关键词匹配和相关性评分过滤内容
- 重分类：文章会按关键词匹配度重新归类到最合适的分类
- 来源均衡：按 priority 对应的统一权重分配每个分类内的信息源配额
- 日报生成：输出 HTML 和 JSON 两种结果文件
- 每日精读：对 sources.json 中配置的一篇长文生成结构化精读
- 邮件发送：支持 QQ 邮箱 SMTP 批量发送
- 定时任务：支持通过 OpenClaw cron 定时触发
- 统一时区：抓取过滤、文件命名、页面展示统一使用 Asia/Shanghai

## 当前分类与信息源

### AI 科技

- 36氪
- 虎嗅
- 量子位
- InfoQ
- 钛媒体
- IT之家

### 深圳房产

- 深圳房天下
- 深圳安居客
- 深圳买房

### 国际战火形势

- 网易军事
- 凤凰军事
- 中华军事

### 医疗与健康

- 网易健康
- 家庭医生

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置抓取源

编辑 [config/sources.json](config/sources.json)。当前核心配置包括：

- globalSettings.minRelevanceScore：最低相关性阈值
- globalSettings.maxArticlesPerCategory：每个分类最多收录条数
- globalSettings.highQualityThreshold：高质量内容阈值
- globalSettings.sourcePriorityWeights：high、medium、low 三档优先级的来源配额权重
- dailyReading.url：每日精读原文地址
- dailyReading.maxInputChars：送入模型的正文最大字符数
- dailyReading.maxOutputTokens：每日精读输出 token 上限
- categories.*.keywords：分类关键词
- categories.*.sources：分类下的信息源

示例：

```json
{
  "globalSettings": {
    "minRelevanceScore": 0.3,
    "maxArticlesPerCategory": 30,
    "highQualityThreshold": 0.7,
    "sourcePriorityWeights": {
      "high": 1.2,
      "medium": 1,
      "low": 0.8
    }
  },
  "dailyReading": {
    "enabled": true,
    "title": "Designing AI-resistant technical evaluations",
    "source": "Anthropic Engineering",
    "url": "https://www.anthropic.com/engineering/AI-resistant-technical-evaluations",
    "maxInputChars": 18000,
    "maxOutputTokens": 2200
  },
  "categories": {
    "ai_tech": {
      "name": "AI科技",
      "enabled": true,
      "keywords": ["AI", "LLM", "大模型"],
      "sources": [
        {
          "name": "36氪",
          "type": "rss",
          "url": "https://36kr.com/feed",
          "enabled": true,
          "priority": "high"
        }
      ]
    }
  }
}
```

### 3. 配置邮件

编辑 [config/settings.json](config/settings.json)：

```json
{
  "email": {
    "smtp": {
      "host": "smtp.qq.com",
      "port": 587,
      "secure": false,
      "user": "your-email@qq.com",
      "pass": "授权码",
      "from": "your-email@qq.com"
    },
    "recipients": ["receiver@example.com"],
    "subject": "AI日报 - {date}",
    "format": "html"
  }
}
```

### 4. 执行命令

```bash
# 生成日报
npm run generate

# 测试项目配置与主流程
npm run test

# 测试 SMTP
npm run test-smtp

# 发送最近生成的日报
npm run send -- send

# 定时任务入口：生成并发送
npm run cron
```

也可以直接使用脚本：

```bash
node scripts/generate-daily.js
node scripts/send-email.js send
node scripts/cron-task.js
```

## 抓取与配额规则

### 抓取方式

- rss：通过 RSSParser 拉取 Feed 并筛选当日内容
- web：直接抓取页面 HTML，抽取链接标题并按关键词过滤

当前代码不再支持 arXiv、GitHub Trending、搜狗新闻等抓取器分支。

### 分类与重分类

- 每条文章先按来源分类进入候选集合
- 之后会根据各分类关键词重新计算匹配度
- 如果别的分类匹配度更高，文章会被重新归入那个分类

### 来源均衡逻辑

- 每个分类有总条数上限，由 globalSettings.maxArticlesPerCategory 控制
- 每个来源的可入选上限不再单独配置
- 系统根据信息源的 priority 读取 globalSettings.sourcePriorityWeights 中的统一权重系数
- 第一轮按来源配额优先保证多样性，第二轮再用剩余候选补满分类名额

这意味着：

- high 优先级来源会获得更多分类内名额
- medium 和 low 会按统一系数缩减
- 调整配额策略时，只需要修改一处全局配置

## 每日精读

- 每次生成日报时，会读取 [config/sources.json](config/sources.json) 中的 dailyReading 配置
- 系统会抓取该 URL 的文章正文，并尽量保留标题、章节和段落结构
- 之后调用 [config/settings.json](config/settings.json) 中配置的 AI 模型生成一篇中文精读
- 默认输出包含：核心摘要、文章结构、关键观点、我的启发
- 结果会同时写入 HTML 日报底部和 JSON 输出文件中的 dailyReading 字段

## 时区规则

项目统一使用 Asia/Shanghai：

- 当日内容过滤
- 日报文件名日期
- 日报页面头部日期
- 每条文章展示日期

统一逻辑集中在 [scripts/timezone.js](scripts/timezone.js)，不再使用手动加 8 小时的写法。

## 目录结构

```text
ai-daily/
├── config/
│   ├── settings.json
│   └── sources.json
├── output/
│   ├── daily-report-YYYY-MM-DD.html
│   └── daily-report-YYYY-MM-DD.json
├── scripts/
│   ├── cron-task.js
│   ├── fetcher.js
│   ├── generate-daily.js
│   ├── send-email.js
│   ├── test-smtp.js
│   ├── test.js
│   └── timezone.js
├── package.json
└── README.md
```

## 核心脚本说明

- [scripts/generate-daily.js](scripts/generate-daily.js)：唯一的日报生成入口，负责抓取、过滤、重分类、统计、生成 HTML/JSON
- [scripts/fetcher.js](scripts/fetcher.js)：抓取实现，只保留 RSS 和 Web 两种抓取器
- [scripts/timezone.js](scripts/timezone.js)：统一上海时区日期处理
- [scripts/send-email.js](scripts/send-email.js)：SMTP 邮件发送与测试
- [scripts/cron-task.js](scripts/cron-task.js)：定时任务入口，串联生成和发送
- [scripts/test.js](scripts/test.js)：项目测试与连通性检查

## 邮件配置说明

### QQ 邮箱

1. 打开 QQ 邮箱 SMTP 服务
2. 使用授权码，不要直接使用登录密码
3. 常用配置：
   - host: smtp.qq.com
   - port: 587
   - secure: false

### 常见问题

- SMTP 连接失败：检查授权码、SMTP 开关和网络
- 抓取结果过少：检查信息源地址、关键词配置和网站结构变化
- 分类被单一来源占满：调整 [config/sources.json](config/sources.json) 中的 sourcePriorityWeights
- 日期显示不一致：检查是否仍有外部脚本绕过 [scripts/timezone.js](scripts/timezone.js)

## 定时任务

如果通过 OpenClaw cron 调度，推荐使用 [scripts/cron-task.js](scripts/cron-task.js) 作为入口。该脚本会：

1. 生成日报
2. 发送邮件
3. 返回适合 cron 使用的执行结果

执行时间建议保持在 Asia/Shanghai。

## 技术栈

- Node.js 18+
- rss-parser
- node-fetch
- nodemailer
- OpenClaw cron

## 更新日志

### 2026-03-24

- 清理旧的 generator.js，只保留 generate-daily.js 作为唯一生成入口
- 抓取器收敛为 RSS 和 Web 两种实现
- 统一 Asia/Shanghai 时区处理，移除手动 +8 小时逻辑
- 将来源配额权重改为全局 priority 映射配置
- 新增 timezone.js 统一处理日期格式化和日期键计算

### 2026-03-23

- 接入真实 RSS 抓取流程
- 实现关键词匹配和相关性过滤
- 完成邮件发送与定时任务链路

## 后续可改进项

- 增加更稳定的网页正文抽取能力
- 为不同分类设置独立的最大条数限制
- 将 SMTP 凭据迁移到环境变量或密钥管理方案
- 为日报生成增加自动化测试覆盖
