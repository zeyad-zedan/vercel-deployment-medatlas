import 'dotenv/config';
import { db, examSessions, users, questionAttempts } from '../src/db/index.ts';
import { desc, gte, eq, count, and, isNotNull } from 'drizzle-orm';

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const configuredChannelId = process.env.TELEGRAM_CHANNEL_ID?.trim();

if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN is missing from .env');
  process.exit(1);
}

/**
 * Builds a rich HTML-formatted student activity digest from the database.
 * Returns an array of message chunks so no data is truncated (e.g. "+43 more"),
 * while staying within Telegram's 4096 character limit per message.
 */
export async function buildActivityReportChunks(hours: number = 6): Promise<string[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const [sessions, newUsers, attemptsAgg] = await Promise.all([
    db
      .select({
        id: examSessions.id,
        title: examSessions.title,
        status: examSessions.status,
        score: examSessions.scorePercentage,
        mode: examSessions.mode,
        startedAt: examSessions.startedAt,
        completedAt: examSessions.completedAt,
        elapsedSeconds: examSessions.elapsedSeconds,
        userName: users.displayName,
        userEmail: users.email,
      })
      .from(examSessions)
      .leftJoin(users, eq(examSessions.userUid, users.uid))
      .where(gte(examSessions.startedAt, since))
      .orderBy(desc(examSessions.startedAt)),
    db
      .select({
        uid: users.uid,
        displayName: users.displayName,
        email: users.email,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(gte(users.createdAt, since))
      .orderBy(desc(users.createdAt)),
    db
      .select({
        isCorrect: questionAttempts.isCorrect,
        count: count(),
      })
      .from(questionAttempts)
      .where(and(gte(questionAttempts.answeredAt, since), isNotNull(questionAttempts.selectedOption)))
      .groupBy(questionAttempts.isCorrect),
  ]);

  const completed = sessions.filter((s) => s.status === 'completed');
  const inProgress = sessions.filter((s) => s.status === 'in_progress');
  const uniqueStudents = Array.from(
    new Set(sessions.map((s) => s.userName || s.userEmail).filter(Boolean))
  );

  const totalMcqs = attemptsAgg.reduce((acc, row) => acc + Number(row.count), 0);
  const correctMcqs = attemptsAgg.find((row) => row.isCorrect)?.count ?? 0;
  const accuracy = totalMcqs > 0 ? Math.round((Number(correctMcqs) / totalMcqs) * 100) : 0;

  const lines: string[] = [];

  lines.push(`📊 <b>MedAtlas Student Activity Report</b>`);
  lines.push(`⏱ <i>Window: Past ${hours} hours</i>`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━\n`);

  lines.push(`👥 <b>Active Students:</b> <code>${uniqueStudents.length}</code>`);
  lines.push(`🎯 <b>Total MCQs Solved:</b> <code>${totalMcqs.toLocaleString()}</code> (<b>${accuracy}%</b> correct)`);
  lines.push(`📝 <b>Quizzes Finished:</b> <code>${completed.length}</code>`);
  lines.push(`⏳ <b>Quizzes In-Progress:</b> <code>${inProgress.length}</code>`);
  lines.push(`🆕 <b>New Registrations:</b> <code>${newUsers.length}</code>\n`);

  // 1. ALL New Registrations (no truncation)
  if (newUsers.length > 0) {
    lines.push(`🆕 <b>All New Registrations (${newUsers.length}):</b>`);
    newUsers.forEach((u, idx) => {
      const name = escapeHtml(u.displayName || 'Student');
      const timeStr = u.createdAt ? new Date(u.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      lines.push(`${idx + 1}. <b>${name}</b> (<code>${u.email}</code>)${timeStr ? ` • <i>${timeStr}</i>` : ''}`);
    });
    lines.push(``);
  }

  // 2. ALL Completed Quizzes (no truncation)
  if (completed.length > 0) {
    lines.push(`🏆 <b>All Completed Quizzes (${completed.length}):</b>`);
    completed.forEach((s, idx) => {
      const dur = Math.round((s.elapsedSeconds || 0) / 60);
      const score = s.score ?? 0;
      const scoreEmoji = score >= 85 ? '🟢' : score >= 60 ? '🟡' : '🔴';
      const name = escapeHtml(s.userName || 'Student');
      const title = escapeHtml(s.title || 'Practice');
      const timeStr = s.completedAt ? new Date(s.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      lines.push(`${idx + 1}. ${scoreEmoji} <b>${name}</b>: ${title}`);
      lines.push(`    └ Score: <b>${score}%</b> (${dur} mins)${timeStr ? ` • <i>${timeStr}</i>` : ''}`);
    });
    lines.push(``);
  }

  // 3. ALL In-Progress Quizzes (no truncation)
  if (inProgress.length > 0) {
    lines.push(`⏳ <b>All Currently In-Progress (${inProgress.length}):</b>`);
    inProgress.forEach((s, idx) => {
      const name = escapeHtml(s.userName || 'Student');
      const title = escapeHtml(s.title || 'Practice');
      const score = s.score ?? 0;
      lines.push(`${idx + 1}. <b>${name}</b> is solving: ${title} (${score}% so far)`);
    });
    lines.push(``);
  }

  lines.push(`🔗 <a href="https://medatlas-exam.vercel.app">Open MedAtlas Admin Dashboard</a>`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━`);

  return splitIntoTelegramChunks(lines);
}

/**
 * Splits lines into chunks <= 3800 characters to safely fit within Telegram's 4096 limit.
 */
function splitIntoTelegramChunks(lines: string[], maxChars: number = 3800): string[] {
  const chunks: string[] = [];
  let currentChunk = '';

  for (const line of lines) {
    const candidate = currentChunk ? `${currentChunk}\n${line}` : line;
    if (candidate.length > maxChars) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = line;
      } else {
        chunks.push(line.slice(0, maxChars));
        currentChunk = line.slice(maxChars);
      }
    } else {
      currentChunk = candidate;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk);
  }

  if (chunks.length > 1) {
    return chunks.map((chunk, idx) => {
      const header = `<i>[Part ${idx + 1}/${chunks.length}]</i>\n`;
      return idx === 0 ? `${chunk}\n\n<i>(Continued in part 2...)</i>` : `${header}${chunk}`;
    });
  }

  return chunks;
}

/**
 * Sends a message to a Telegram chat.
 */
export async function sendTelegramMessage(chatId: string | number, text: string) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = (await res.json().catch(() => null)) as any;
  if (!res.ok || !data?.ok) {
    throw new Error(`Telegram sendMessage failed (${res.status}): ${data?.description || 'Unknown error'}`);
  }
  return data;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function sendActivityReport(chatId: string | number, hours: number) {
  const chunks = await buildActivityReportChunks(hours);
  for (const chunk of chunks) {
    await sendTelegramMessage(chatId, chunk);
    // Brief 300ms pause between chunks to preserve Telegram order
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * Interactive Telegram Listener (Long-polling)
 * Listens for commands like /report, /stats, /help from you on Telegram and answers on-demand.
 */
async function startListener() {
  console.log('🤖 MedAtlas Telegram Activity Bot is running!');
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10000) });
  const identity = await response.json() as any;
  if (!identity?.ok) throw new Error('Telegram bot credentials rejected.');
  console.log(`Bot username: @${identity.result.username}`);
  console.log(`Send /report or /help to the bot on Telegram to receive live student updates.\n`);

  let offset = 0;

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=20`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const data = (await res.json().catch(() => null)) as any;

      if (!res.ok || !data?.ok) throw new Error(`Telegram polling failed (${res.status}): ${data?.description || 'unknown error'}`);
      if (Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          const msg = update.message || update.channel_post;
          if (!msg || !msg.text) continue;

          const text = msg.text.trim();
          const chatId = msg.chat.id;
          const fromUser = msg.from ? `${msg.from.first_name || ''} (@${msg.from.username || 'no-username'})` : 'Unknown';

          console.log(`📩 Received message: "${text}" from ${fromUser} (Chat ID: ${chatId})`);

          // Handle Commands
          if (text.startsWith('/start') || text.startsWith('/help')) {
            const helpText =
              `🩺 <b>Welcome to MedAtlas Live Activity Bot!</b>\n\n` +
              `Send any of these commands to get real-time student updates:\n\n` +
              `• <code>/report</code> — Summary of student activity in the last 6 hours\n` +
              `• <code>/report 12</code> — Summary for the last 12 hours\n` +
              `• <code>/report 24</code> — Summary for the last 24 hours\n` +
              `• <code>/today</code> — Today's full performance summary\n` +
              `• <code>/ping</code> — Test bot connection\n\n` +
              `🔗 <a href="https://medatlas-exam.vercel.app">Admin Dashboard</a>`;
            await sendTelegramMessage(chatId, helpText);
            console.log(`✅ Sent help reply to ${chatId}`);
          } else if (text.startsWith('/report') || text.toLowerCase() === 'report' || text.toLowerCase() === 'stats') {
            const parts = text.split(/\s+/);
            const hours = parts.length > 1 && !isNaN(Number(parts[1])) ? Math.max(1, Math.min(168, Number(parts[1]))) : 6;
            
            console.log(`⏳ Generating and sending full ${hours}-hour report to ${chatId}...`);
            await sendActivityReport(chatId, hours);
            console.log(`✅ Sent ${hours}-hour report to ${chatId}`);
          } else if (text.startsWith('/today')) {
            const now = new Date();
            const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            const hoursSinceMidnight = Math.max(1, Math.ceil((Date.now() - startOfToday) / (1000 * 60 * 60)));
            console.log(`⏳ Generating and sending today's report (${hoursSinceMidnight}h) to ${chatId}...`);
            await sendActivityReport(chatId, hoursSinceMidnight);
            console.log(`✅ Sent today's report to ${chatId}`);
          } else if (text.startsWith('/ping')) {
            await sendTelegramMessage(chatId, '🏓 <b>Pong!</b> MedAtlas Bot is connected and online.');
          }
        }
      }
    } catch (err: any) {
      console.warn('Listener loop notice:', err?.message || err);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// Check if user called with --once flag to just generate and send one report immediately
const isOnce = process.argv.includes('--once');
if (isOnce) {
  const targetChat = process.argv[3] || configuredChannelId;
  const hoursArg = process.argv[4] ? Number(process.argv[4]) : 6;
  if (!targetChat) {
    console.error('Target chat ID missing');
    process.exit(1);
  }
  sendActivityReport(targetChat, hoursArg)
    .then(() => {
      console.log(`✅ Sent full report (${hoursArg}h) to Telegram!`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error sending report:', err);
      process.exit(1);
    });
} else {
  startListener();
}
