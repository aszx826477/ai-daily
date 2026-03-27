/**
 * AI日报系统 - Cron定时任务入口
 * 此脚本由OpenClaw cron系统定时调用
 */

import { generateDaily } from './generate-daily.js';
import { sendDailyReport } from './send-email.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.dirname(__dirname);

// 日志
const log = {
  info: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
  success: (msg) => console.log(`[${new Date().toISOString()}] ✓ ${msg}`),
  error: (msg) => console.error(`[${new Date().toISOString()}] ✗ ${msg}`)
};

/**
 * 定时任务主函数
 * 1. 生成日报
 * 2. 发送邮件
 */
async function cronTask() {
  log.info('🚀 AI日报定时任务启动');
  log.info('='.repeat(50));
  
  const startTime = Date.now();
  
  try {
    // 1. 生成日报
    log.info('\n📝 步骤1: 生成日报...');
    const result = await generateDaily();
    
    if (!result || !result.filepath) {
      throw new Error('日报生成失败，未生成HTML文件');
    }
    
    log.success(`日报生成成功: ${result.filepath}`);
    log.info(`统计: 总计${result.stats.totalArticles}条, 高质量${result.stats.highQualityCount}条`);
    
    // 2. 发送邮件
    log.info('\n📧 步骤2: 发送日报邮件...');
    const emailResult = await sendDailyReport(result.filepath);
    
    if (emailResult.success) {
      log.success(`邮件发送成功! 收件人: ${emailResult.recipients.join(', ')}`);
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    log.info('\n' + '='.repeat(50));
    log.success(`✅ AI日报任务完成，总耗时 ${elapsed}s`);
    
    // 返回结果供cron系统使用
    return {
      success: true,
      date: result.date,
      articlesCount: result.stats.totalArticles,
      highQualityCount: result.stats.highQualityCount,
      elapsed
    };
    
  } catch (error) {
    log.error(`❌ 任务失败: ${error.message}`);
    log.error(error.stack);
    
    return {
      success: false,
      error: error.message
    };
  }
}

// 执行
cronTask()
  .then(result => {
    if (result.success) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
