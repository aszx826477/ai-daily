/**
 * AI日报系统 - 邮件发送模块
 * 使用QQ邮箱SMTP发送日报
 */

import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeRunLogger, log } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.dirname(__dirname);

const SETTINGS = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config', 'settings.json'), 'utf-8'));

function getEmailSettings() {
  return SETTINGS.email || {};
}

function getSmtpSettings() {
  return getEmailSettings().smtp || {};
}

// SMTP配置
function createTransporter() {
  const smtp = getSmtpSettings();
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.user,
      pass: smtp.pass
    }
  });
}

function formatDateInShanghai(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;

  return `${year}-${month}-${day}`;
}

/**
 * 发送日报邮件
 * @param {string} htmlPath - HTML文件路径
 * @param {Object} options - 额外选项
 */
export async function sendDailyReport(htmlPath, options = {}) {
  const emailSettings = getEmailSettings();
  const smtp = getSmtpSettings();
  const date = options.date || formatDateInShanghai();
  const recipients = options.recipients || emailSettings.recipients || [];
  
  log.info(`📧 准备发送日报邮件...`);
  log.info(`收件人: ${recipients.join(', ')}`);
  
  // 解析文件路径（相对于 ROOT_DIR）
  const resolvedPath = path.isAbsolute(htmlPath) ? htmlPath : path.join(ROOT_DIR, htmlPath);
  
  // 检查文件是否存在
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`HTML文件不存在: ${resolvedPath}`);
  }
  
  const htmlContent = fs.readFileSync(resolvedPath, 'utf-8');
  
  // 创建传输器
  const transporter = createTransporter();
  
  // 验证连接
  try {
    await transporter.verify();
    log.success('SMTP连接成功');
  } catch (error) {
    log.error('SMTP连接失败:', error.message);
    throw error;
  }
  
  // 构建邮件
  const mailOptions = {
    from: `"AI日报" <${smtp.from || smtp.user}>`,
    to: recipients.join(', '),
    subject: (emailSettings.subject || 'AI日报 - {date}').replace('{date}', date),
    html: htmlContent,
    headers: {
      'X-Priority': '1',
      'X-Mailer': 'AI日报系统'
    }
  };
  
  // 发送邮件
  try {
    const info = await transporter.sendMail(mailOptions);
    log.success(`邮件发送成功!`);
    log.info(`Message ID: ${info.messageId}`);
    log.info(`Response: ${info.response}`);
    
    return {
      success: true,
      messageId: info.messageId,
      recipients
    };
    
  } catch (error) {
    log.error('邮件发送失败:', error.message);
    throw error;
  }
}

/**
 * 测试SMTP连接
 */
export async function testSMTPConnection() {
  log.info('🔍 测试SMTP连接...');
  
  const transporter = createTransporter();
  const smtp = getSmtpSettings();
  
  try {
    await transporter.verify();
    log.success('✅ SMTP连接测试成功!');
    log.info(`SMTP服务器: ${smtp.host}:${smtp.port}`);
    log.info(`用户: ${smtp.user}`);
    return true;
  } catch (error) {
    log.error('❌ SMTP连接测试失败:', error.message);
    return false;
  }
}

/**
 * 发送测试邮件
 */
export async function sendTestEmail() {
  log.info('📧 发送测试邮件...');
  
  const transporter = createTransporter();
  const emailSettings = getEmailSettings();
  const smtp = getSmtpSettings();
  const recipients = emailSettings.recipients || [];
  
  const mailOptions = {
    from: `"AI日报系统" <${smtp.from || smtp.user}>`,
    to: recipients.join(', '),
    subject: 'AI日报系统 - 测试邮件',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #667eea;">🤖 AI日报系统测试</h1>
        <p>这是一封测试邮件，用于验证邮件发送功能。</p>
        <p>发送时间: ${new Date().toLocaleString('zh-CN')}</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="color: #888; font-size: 0.9em;">AI日报系统 自动发送</p>
      </div>
    `
  };
  
  try {
    const info = await transporter.sendMail(mailOptions);
    log.success('✅ 测试邮件发送成功!');
    log.info(`Message ID: ${info.messageId}`);
    return true;
  } catch (error) {
    log.error('❌ 测试邮件发送失败:', error.message);
    return false;
  }
}

// CLI入口
async function main() {
  initializeRunLogger(SETTINGS);
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'test':
      await testSMTPConnection();
      break;
    case 'send-test':
      await sendTestEmail();
      break;
    case 'send': {
      const htmlFile = args[1] || findLatestReport();
      if (htmlFile) {
        await sendDailyReport(htmlFile);
      } else {
        log.error('未找到日报HTML文件');
      }
      break;
    }
    default:
      log.info('用法:');
      log.info('  node send-email.js test        - 测试SMTP连接');
      log.info('  node send-email.js send-test   - 发送测试邮件');
      log.info('  node send-email.js send [file] - 发送日报');
  }
}

// 查找最新日报
function findLatestReport() {
  const outputDir = path.join(ROOT_DIR, 'output');
  if (!fs.existsSync(outputDir)) return null;
  
  const files = fs.readdirSync(outputDir)
    .filter(f => f.startsWith('daily-report-') && f.endsWith('.html'))
    .sort()
    .reverse();
  
  return files[0] ? path.join(outputDir, files[0]) : null;
}

// 直接运行
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  main().catch(console.error);
}

export default sendDailyReport;
