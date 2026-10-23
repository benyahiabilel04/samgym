'use strict';
/* نقطة دخول Node داخل تطبيق أندرويد: تهيئة بسيطة ثم تشغيل الخادم نفسه */
const os = require('os'), path = require('path');
const orig = os.networkInterfaces;
os.networkInterfaces = function(){ try{ return orig.call(os); }catch(e){ return {}; } };   // أندرويد قد يرفض قراءة الواجهات
process.chdir(__dirname);
process.on('uncaughtException', e => console.error('uncaught:', e && e.stack || e));
require(path.join(__dirname, 'server.js'));
