require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express     = require('express');
const cors        = require('cors');

const TOKEN      = process.env.BOT_TOKEN  || '8391766294:AAH0HhI-mHBBXdCrv8D-ViKdhXCixCw8Y0g';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://panelitachi1-lang.github.io/nft-upgrader';
const PORT       = process.env.PORT       || 3001;

// ── ADMINS — добавь свой Telegram ID (узнать: написать @userinfobot) ──
const ADMINS = [process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : 0];

// ── ITEMS ──
const ITEMS = [
  { id:1,  name:'Plush Heart',       value:15,    emoji:'🫀' },
  { id:2,  name:'Teddy Bear',        value:15,    emoji:'🐻' },
  { id:3,  name:'Homemade Cake',     value:50,    emoji:'🎂' },
  { id:4,  name:'Trophy',            value:100,   emoji:'🏆' },
  { id:5,  name:'Instant Noodles',   value:380,   emoji:'🍜' },
  { id:6,  name:'Ice Cream',         value:399,   emoji:'🍦' },
  { id:7,  name:'Statue of Liberty', value:470,   emoji:'🗽' },
  { id:8,  name:'Lollipop',          value:482,   emoji:'🍭' },
  { id:9,  name:'Backpack',          value:500,   emoji:'🎒' },
  { id:10, name:'Blue Socks',        value:529,   emoji:'🧦' },
  { id:11, name:'Bag of Coins',      value:560,   emoji:'💰' },
  { id:12, name:'Burning Joint',     value:1349,  emoji:'🔥' },
  { id:13, name:'Golden Watch',      value:4879,  emoji:'⌚' },
  { id:14, name:'Sunglasses',        value:10845, emoji:'🕶' },
];

function fmtVal(v){ return v>=1000?(v/1000).toFixed(0)+'k':String(v); }

// ── ХРАНИЛИЩЕ (память, можно заменить на БД) ──
const userInventories = {}; // { userId: [{itemId, count}] }
const userBalances    = {}; // { userId: stars }
const pendingAddNft   = {}; // { adminChatId: { targetUsername, targetUserId } }

function getInv(userId){
  if(!userInventories[userId]) userInventories[userId]=[];
  return userInventories[userId];
}
function addToInv(userId, itemId){
  const inv=getInv(userId);
  const e=inv.find(x=>x.itemId===itemId);
  if(e) e.count++; else inv.push({itemId,count:1});
}
function isAdmin(userId){ return ADMINS.includes(userId) || ADMINS[0]===0; }

const bot = new TelegramBot(TOKEN, { polling:true });
const app = express();
app.use(cors({origin:'*'}));
app.use(express.json());

// ── Аватарки пользователей ──
const userPhotos = {}; // { userId: photoUrl }

async function fetchUserPhoto(userId) {
  if (userPhotos[userId]) return userPhotos[userId];
  try {
    const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
    if (photos.total_count > 0) {
      const fileId = photos.photos[0][0].file_id;
      const file   = await bot.getFile(fileId);
      const url    = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
      userPhotos[userId] = url;
      return url;
    }
  } catch(e) {}
  return null;
}

// API для фронта — получить фото пользователя
app.get('/photo/:userId', async (req, res) => {
  const url = await fetchUserPhoto(parseInt(req.params.userId));
  if (url) res.json({ url });
  else res.json({ url: null });
});
const sseClients = new Set();
function broadcast(event){
  const d=`data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(r=>{ try{r.write(d);}catch(e){sseClients.delete(r);} });
}
app.get('/feed',(req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close',()=>sseClients.delete(res));
});

// ── Хранилище пользователей (username → userId) ──
const knownUsers = {}; // { username: userId }

// ── /start ──
bot.onText(/\/start/,(msg)=>{
  const chatId=msg.chat.id, name=msg.from.first_name||'друг';
  // Запоминаем пользователя
  if(msg.from.username) knownUsers[msg.from.username.toLowerCase()] = chatId;
  knownUsers[chatId] = chatId;
  
  bot.sendMessage(chatId,
    `👋 Привет, *${name}*!\n\n🎰 *NFT Upgrader* — апгрейди свои подарки!\n\nКупи предмет в магазине и попробуй выиграть что-то дороже.`,
    { parse_mode:'Markdown',
      reply_markup:{inline_keyboard:[[
        {text:'🎮 Открыть апгрейдер', web_app:{url:WEBAPP_URL}}
      ],[
        {text:'⭐ Пополнить баланс', callback_data:'topup'},
      ]]}
    }
  );
});

// ── /upgrade ──
bot.onText(/\/upgrade/,(msg)=>{
  bot.sendMessage(msg.chat.id,'🎰 Открыть апгрейдер:',{
    reply_markup:{inline_keyboard:[[{text:'⬆ Апгрейдер',web_app:{url:WEBAPP_URL}}]]}
  });
});

// ── /addnft @username ──
bot.onText(/\/addnft(?:\s+(@\S+))?/,async(msg,match)=>{
  const adminId=msg.from.id, chatId=msg.chat.id;
  if(!isAdmin(adminId)){
    bot.sendMessage(chatId,'❌ У вас нет прав администратора.');
    return;
  }
  const username=match[1];
  if(!username){
    bot.sendMessage(chatId,'⚠️ Использование: /addnft @username\n\nПример: /addnft @durov');
    return;
  }

  // Сохраняем цель
  pendingAddNft[chatId]={ targetUsername:username, targetUserId:null };

  // Показываем список подарков кнопками (по 2 в ряд)
  const rows=[];
  for(let i=0;i<ITEMS.length;i+=2){
    const row=[];
    const a=ITEMS[i];
    row.push({text:`${a.emoji} ${a.name} — ${fmtVal(a.value)}⭐`, callback_data:`addnft_${a.id}_${username}`});
    if(ITEMS[i+1]){
      const b=ITEMS[i+1];
      row.push({text:`${b.emoji} ${b.name} — ${fmtVal(b.value)}⭐`, callback_data:`addnft_${b.id}_${username}`});
    }
    rows.push(row);
  }
  rows.push([{text:'❌ Отмена', callback_data:'addnft_cancel'}]);

  bot.sendMessage(chatId,
    `🎁 Выдать подарок для *${username}*\n\nВыбери предмет:`,
    { parse_mode:'Markdown', reply_markup:{inline_keyboard:rows} }
  );
});

// ── /addstars @username количество ──
bot.onText(/\/addstars(?:\s+(@\S+))?(?:\s+(\d+))?/, async (msg, match) => {
  const adminId = msg.from.id, chatId = msg.chat.id;
  if(!isAdmin(adminId)){ bot.sendMessage(chatId,'❌ Нет прав.'); return; }

  const username = match[1];
  const amount   = parseInt(match[2]);

  if(!username || !amount || amount < 1){
    bot.sendMessage(chatId,
      `⚠️ Использование:\n\`/addstars @username количество\`\n\nПример: \`/addstars @durov 500\``,
      {parse_mode:'Markdown'}
    );
    return;
  }

  try{
    const cleanUsername = username.replace('@','').toLowerCase();
    let targetId = knownUsers[cleanUsername];

    if(!targetId){
      try{
        const targetChat = await bot.getChat(username);
        targetId = targetChat.id;
        if(targetChat.username) knownUsers[targetChat.username.toLowerCase()] = targetId;
      } catch(e){
        bot.sendMessage(chatId,
          `❌ Пользователь *${username}* не найден.\n\nПопроси его написать /start боту сначала.`,
          {parse_mode:'Markdown'}
        );
        return;
      }
    }

    // Начисляем баланс
    if(!userBalances[targetId]) userBalances[targetId] = 0;
    userBalances[targetId] += amount;

    // Уведомляем админа
    bot.sendMessage(chatId,
      `✅ *+${amount} ⭐* зачислено на баланс *${username}*!\n\nНовый баланс: *${userBalances[targetId]} ⭐*`,
      {parse_mode:'Markdown'}
    );

    // Уведомляем пользователя — открываем мини апп с параметром
    const starsUrl = `${WEBAPP_URL}?stars=${amount}`;
    bot.sendMessage(targetId,
      `⭐ *Вам начислено ${amount} Stars!*\n\nНажми кнопку чтобы получить на баланс:`,
      { parse_mode:'Markdown',
        reply_markup:{inline_keyboard:[[{text:`⭐ Получить ${amount} Stars!`, web_app:{url:starsUrl}}]]}
      }
    );

    broadcast({type:'balance_add', userId:targetId, stars:amount});
    console.log(`⭐ AddStars: ${amount} → ${username} (${targetId})`);

  } catch(e){
    bot.sendMessage(chatId,`❌ Ошибка: ${e.message}`);
  }
});

// ── /addstars без параметров — выдать себе (только админ) ──
bot.onText(/\/mybalance/, async (msg) => {
  const chatId = msg.chat.id;
  const bal = userBalances[chatId] || 0;
  bot.sendMessage(chatId, `⭐ Твой баланс: *${bal} Stars*`, {parse_mode:'Markdown'});
});
bot.onText(/\/myid/,(msg)=>{
  bot.sendMessage(msg.chat.id,`🆔 Твой Telegram ID: \`${msg.from.id}\`\n\nДобавь его в ADMINS в боте.`,{parse_mode:'Markdown'});
});

// ── Callback кнопки ──
bot.on('callback_query',async(query)=>{
  const chatId=query.message.chat.id, adminId=query.from.id;
  const data=query.data;
  bot.answerCallbackQuery(query.id);

  // Отмена addnft
  if(data==='addnft_cancel'){
    delete pendingAddNft[chatId];
    bot.editMessageText('❌ Отменено.',{chat_id:chatId, message_id:query.message.message_id});
    return;
  }

  // Выдача подарка: addnft_{itemId}_{username}
  if(data.startsWith('addnft_')){
    if(!isAdmin(adminId)){ return; }
    const parts=data.split('_');
    const itemId=parseInt(parts[1]);
    const username=parts.slice(2).join('_');
    const item=ITEMS.find(i=>i.id===itemId);
    if(!item) return;

    // Ищем userId — сначала в knownUsers, потом через getChat
    try{
      const cleanUsername = username.replace('@','').toLowerCase();
      let targetId = knownUsers[cleanUsername];
      
      if(!targetId){
        // Пробуем через getChat
        try{
          const targetChat = await bot.getChat(username);
          targetId = targetChat.id;
          if(targetChat.username) knownUsers[targetChat.username.toLowerCase()] = targetId;
        } catch(e){
          bot.editMessageText(
            `❌ Пользователь *${username}* не найден.\n\nПопроси его написать /start боту — тогда смогу его найти.`,
            {chat_id:chatId, message_id:query.message.message_id, parse_mode:'Markdown'}
          );
          return;
        }
      }

      // Добавляем в инвентарь
      addToInv(targetId, itemId);

      // Уведомляем админа
      bot.editMessageText(
        `✅ *${item.emoji} ${item.name}* выдан пользователю *${username}*!\n\n💎 Стоимость: ${item.value.toLocaleString()} ⭐`,
        {chat_id:chatId, message_id:query.message.message_id, parse_mode:'Markdown'}
      );

      // Уведомляем пользователя
      try {
        const giftUrl = `${WEBAPP_URL}?gift=${itemId}`;
        bot.sendMessage(targetId,
          `🎁 *Вам выдан подарок!*\n\n${item.emoji} *${item.name}*\n💎 Стоимость: ${item.value.toLocaleString()} ⭐\n\nНажми кнопку чтобы получить предмет в инвентарь!`,
          { parse_mode:'Markdown',
            reply_markup:{inline_keyboard:[[{text:'🎁 Получить подарок!', web_app:{url:giftUrl}}]]}
          }
        );
      } catch(e){}

      broadcast({type:'gift_received', userId:targetId, itemId});
      console.log(`🎁 Gift: ${item.name} → ${username} (${targetId})`);

    } catch(e){
      bot.editMessageText(
        `❌ Пользователь *${username}* не найден или не писал боту.\n\nПопроси его написать /start боту сначала.`,
        {chat_id:chatId, message_id:query.message.message_id, parse_mode:'Markdown'}
      );
    }
    return;
  }

  // Пополнение баланса
  if(data==='topup'){
    await bot.sendInvoice(chatId,'⭐ Пополнение баланса','Пополни баланс NFT Upgrader!',`topup_100_${Date.now()}`,'','XTR',[{label:'100 Stars на баланс',amount:100}]);
  }
});

// ── Pre-checkout ──
bot.on('pre_checkout_query',(q)=>bot.answerPreCheckoutQuery(q.id,true));

// ── Успешная оплата ──
bot.on('message',(msg)=>{
  if(!msg.successful_payment) return;
  const stars=msg.successful_payment.total_amount, chatId=msg.chat.id;
  const payload=msg.successful_payment.invoice_payload;

  if(payload.startsWith('topup_')){
    if(!userBalances[chatId]) userBalances[chatId]=0;
    userBalances[chatId]+=stars;
    broadcast({type:'balance_add', userId:chatId, stars});
    bot.sendMessage(chatId,
      `✅ *Баланс пополнен!*\n\n⭐ *+${stars} Stars* зачислено!\n\nОткрой апгрейдер и играй 🎰`,
      {parse_mode:'Markdown', reply_markup:{inline_keyboard:[[{text:'🎮 Апгрейдер', web_app:{url:WEBAPP_URL}}]]}}
    );
    return;
  }

  const match=payload.match(/buy_item_(\d+)_/);
  const itemId=match?parseInt(match[1]):null;
  if(itemId){ addToInv(chatId,itemId); broadcast({type:'purchase',userId:chatId,itemId,stars}); }
  bot.sendMessage(chatId,`✅ Покупка успешна! Предмет добавлен в инвентарь.`,{
    reply_markup:{inline_keyboard:[[{text:'🎮 Апгрейдер',web_app:{url:WEBAPP_URL}}]]}
  });
});

// ── WebApp данные ──
bot.on('message',(msg)=>{
  if(!msg.web_app_data) return;
  try{
    const data=JSON.parse(msg.web_app_data.data), chatId=msg.chat.id;
    if(data.action==='topup'){
      const amount=Math.max(1,parseInt(data.amount)||1);
      bot.sendInvoice(chatId,'⭐ Пополнение',`Пополнение на ${amount} Stars`,`topup_${amount}_${Date.now()}`,'','XTR',[{label:`${amount} Stars`,amount}]);
    }
    if(data.action==='buy'){
      bot.sendInvoice(chatId,`🎁 ${data.itemName}`,`Покупка "${data.itemName}"`,`buy_item_${data.itemId}_${Date.now()}`,'','XTR',[{label:data.itemName,amount:data.price}]);
    }
    if(data.action==='upgrade_result'){
      broadcast({type:'upgrade',win:data.win,betName:data.betName,betImg:data.betImg,betVal:data.betVal,prizeName:data.prizeName,prizeImg:data.prizeImg,prizeVal:data.prizeVal,user:msg.from.first_name||'Игрок',ts:Date.now()});
    }
    if(data.action==='get_inventory'){
      // Отдаём инвентарь пользователя
      const inv=getInv(chatId);
      broadcast({type:'inventory_sync', userId:chatId, inventory:inv});
    }
  }catch(e){console.error(e);}
});

// ── API ──
app.get('/health',(req,res)=>res.json({ok:true,clients:sseClients.size}));
app.get('/inventory/:userId',(req,res)=>res.json(getInv(parseInt(req.params.userId))));

app.listen(PORT,()=>{
  console.log('Bot is running...');
  console.log(`🤖 Bot started!`);
  console.log(`🌐 API: http://localhost:${PORT}`);
  console.log(`🔗 WebApp: ${WEBAPP_URL}`);
  console.log(`📡 SSE: http://localhost:${PORT}/feed`);
});

bot.setMyCommands([
  {command:'start',     description:'🏠 Главное меню'},
  {command:'upgrade',   description:'🎰 Открыть апгрейдер'},
  {command:'myid',      description:'🆔 Узнать свой ID'},
  {command:'mybalance', description:'⭐ Мой баланс'},
  {command:'addnft',    description:'🎁 Выдать подарок (админ)'},
  {command:'addstars',  description:'⭐ Выдать Stars (админ)'},
]);
