const url = 'https://whatsappbackend-production-9e33.up.railway.app/status?sessionId=test4';
setInterval(() => {
  fetch(url).then(r => r.json()).then(console.log).catch(console.error);
}, 2000);
