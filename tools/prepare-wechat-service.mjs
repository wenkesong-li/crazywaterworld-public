import { prepareWechatService } from '../src/custom/wechat-service.mjs';
await prepareWechatService();
console.log('微信扫码服务已下载并通过SHA256校验，获取二维码时自动启动。');
