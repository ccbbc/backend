const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const players = new Map();

app.post('/api/firework', (req, res) => {
  const { playerName, uuid, avatarUrl } = req.body || {};
  if (!playerName || !uuid) {
    return res.status(400).json({ ok: false, error: 'playerName and uuid are required' });
  }
  players.set(uuid, { name: playerName, avatar: avatarUrl || null });
  return res.json({ ok: true });
});

app.get('/api/poem', (req, res) => {
  const yearWish = [
    '在时间的光柱下，愿你我在2026年继续向上',
    '愿团圆常在，愿心愿如光，穿云破夜',
    '愿每一盏花灯，都点亮一个温暖的回忆',
  ];

  const summary2025 = [
    '2025，我们学会了告别与重逢',
    '我们把每一次微小的努力，都化作光',
    '我们在低谷沉潜，在高处眺望',
  ];

  const names = Array.from(players.values()).map(p => p.name).filter(Boolean);
  const nameLine = names.length > 0 ? `光柱尽头，铭刻着：${names.join('、')}` : '光柱尽头，等待着第一位点灯的人';

  const lines = [
    '—— 终末之诗 · 新年篇 ——',
    '',
    ...yearWish,
    '',
    ...summary2025,
    '',
    '愿你下次抬头时，仍能看见这束温柔的红光',
    nameLine,
    '',
    '新年快乐 · Happy New Year'
  ];

  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines.join('\n'));
});

const port = process.env.PORT ? Number(process.env.PORT) : 8787;
app.listen(port, () => {
  console.log(`New Year backend listening on http://localhost:${port}/`);
});

