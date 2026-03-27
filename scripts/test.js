/**
 * AI日报系统 - 测试脚本
 */

import { testSMTPConnection, sendTestEmail } from './send-email.js';
import { generateDaily } from './generate-daily.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.dirname(__dirname);

const log = {
  info: (msg) => console.log(`\nℹ️  ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  error: (msg) => console.log(`❌ ${msg}`)
};

async function runTests() {
  console.log('🧪 AI日报系统测试');
  console.log('='.repeat(50));
  
  // 测试1: 配置文件
  log.info('测试1: 检查配置文件...');
  try {
    const sourcesPath = path.join(ROOT_DIR, 'config', 'sources.json');
    const settingsPath = path.join(ROOT_DIR, 'config', 'settings.json');
    
    if (fs.existsSync(sourcesPath) && fs.existsSync(settingsPath)) {
      const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf-8'));
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      log.success(`配置文件加载成功`);
      log.info(`信息源分类: ${Object.keys(sources.categories).join(', ')}`);
      log.info(`邮件收件人: ${settings.email.recipients.join(', ')}`);
    } else {
      log.error('配置文件不存在');
    }
  } catch (e) {
    log.error(`配置文件解析失败: ${e.message}`);
  }
  
  // 测试2: SMTP连接
  log.info('测试2: SMTP连接测试...');
  try {
    const result = await testSMTPConnection();
    if (result) {
      log.success('SMTP连接正常');
    } else {
      log.error('SMTP连接失败');
    }
  } catch (e) {
    log.error(`SMTP测试失败: ${e.message}`);
  }
  
  // 测试3: 生成日报
  log.info('测试3: 生成日报测试...');
  try {
    const result = await generateDaily();
    log.success(`日报生成成功: ${result.filepath}`);
    log.info(`文章数: ${result.stats.totalArticles}, 高质量: ${result.stats.highQualityCount}`);
  } catch (e) {
    log.error(`日报生成失败: ${e.message}`);
  }
  
  // 测试4: 发送测试邮件
  log.info('测试4: 发送测试邮件...');
  log.info('是否发送测试邮件到 yelbee@qq.com? (此测试跳过，请手动运行)');
  // 可以取消注释来实际发送测试邮件
  // await sendTestEmail();
  
  console.log('\n' + '='.repeat(50));
  console.log('测试完成!\n');
  console.log('手动测试命令:');
  console.log('  node scripts/send-email.js test       - 测试SMTP连接');
  console.log('  node scripts/send-email.js send-test  - 发送测试邮件');
  console.log('  node scripts/generate-daily.js        - 生成日报');
  console.log('  node scripts/cron-task.js             - 运行完整定时任务');
}

runTests().catch(console.error);
