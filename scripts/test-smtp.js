// 简单的SMTP测试脚本
import nodemailer from 'nodemailer';

console.log('🔍 测试SMTP连接...');

const transporter = nodemailer.createTransport({
  host: 'smtp.qq.com',
  port: 587,
  secure: false,
  auth: {
    user: 'yelbee@qq.com',
    pass: 'fymbemxciychbfad'
  }
});

// 测试连接
transporter.verify()
  .then(() => {
    console.log('✅ SMTP连接成功!');
    console.log('   服务器: smtp.qq.com:587');
    console.log('   用户: yelbee@qq.com');
    
    // 发送测试邮件
    console.log('\n📧 发送测试邮件...');
    return transporter.sendMail({
      from: '"AI日报系统" <yelbee@qq.com>',
      to: 'yelbee@qq.com',
      subject: 'AI日报系统 - SMTP测试成功',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h1 style="color: #667eea;">✅ SMTP配置成功!</h1>
          <p>AI日报系统邮件发送功能已配置完成。</p>
          <p>测试时间: ${new Date().toLocaleString('zh-CN')}</p>
        </div>
      `
    });
  })
  .then(info => {
    console.log('✅ 测试邮件发送成功!');
    console.log(`   Message ID: ${info.messageId}`);
  })
  .catch(err => {
    console.error('❌ 错误:', err.message);
  });
