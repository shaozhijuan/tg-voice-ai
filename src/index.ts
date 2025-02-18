import { createWorkersAI } from 'workers-ai-provider';
import { streamText } from 'ai';

export interface Env {
	// aivoice: KVNamespace; // 可用于存储转录结果
	AI: Ai; // Cloudflare AI 模型服务
	tg_token: string; // Telegram 机器人 Token
	tg_chat_id: string; // Telegram 目标聊天 ID
}
export interface TelegramFileResponse {
	ok: boolean;
	result: {
		file_path: string;
	};
}
const WHISPER_MODEL = '@cf/openai/whisper'; // Whisper 模型路径

// 使用 Whisper 模型进行语音转录
async function transcribeAudio(blob: Blob, env: Env): Promise<string> {
	const audioArray = new Uint8Array(await blob.arrayBuffer()); // 转换 Blob 为 Uint8Array
	const response = await env.AI.run(WHISPER_MODEL, {
		audio: [...audioArray], // 将音频数据传递给 AI
	});
	return response.text; // 返回转录文本
}
async function getWebhookInfo(env: Env): Promise<any> {
	const webhookInfoUrl = `https://api.telegram.org/bot${env.tg_token}/getWebhookInfo`;

	const response = await fetch(webhookInfoUrl);
	const data = await response.json();

	return data;
} // 修改注册逻辑，避免重复注册
async function registerTelegramWebhook(workerUrl: string, env: Env): Promise<any> {
	const webhookInfo = await getWebhookInfo(env);

	if (webhookInfo.result?.url === workerUrl) {
		// 当前 Webhook 已正确注册，无需重新设置
		return { ok: true, result: 'Webhook already registered' };
	}

	const webhookApiUrl = `https://api.telegram.org/bot${env.tg_token}/setWebhook`;

	const body = JSON.stringify({
		url: workerUrl,
	});

	const response = await fetch(webhookApiUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body,
	});

	return await response.json();
}
// 获取 Telegram 文件的下载链接
async function getTelegramFileLink(fileId: string, env: Env): Promise<string> {
	const tgApiUrl = `https://api.telegram.org/bot${env.tg_token}/getFile?file_id=${fileId}`;
	const res = await fetch(tgApiUrl);
	const data: TelegramFileResponse = await res.json();

	if (!data.ok) {
		throw new Error(`Failed to get Telegram file: ${JSON.stringify(data)}`);
	}

	const filePath = data.result.file_path;
	return `https://api.telegram.org/file/bot${env.tg_token}/${filePath}`;
}

// 处理 Telegram 更新请求
async function handleTelegramUpdate(update: any, env: Env): Promise<Response> {
	if (!update.message?.voice) {
		return new Response('No voice message found', { status: 400 });
	}

	const fileId = update.message.voice.file_id;

	// 获取语音文件下载链接
	const fileUrl = await getTelegramFileLink(fileId, env);
	const audioResponse = await fetch(fileUrl);
	const blob = await audioResponse.blob();

	// 转录语音文件
	const transcription = await transcribeAudio(blob, env);
	// 回复用户转录结果
	const chatId = update.message.chat.id;
	const messageUrl = `https://api.telegram.org/bot${env.tg_token}/sendMessage`;
	await fetch(messageUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text: `Transcription: ${transcription}`,
		}),
	});

	return new Response('OK');
}


export default {
	// 处理 Telegram Webhook 请求
	async fetch(request: Request, env: Env): Promise<Response> {
		// Worker 运行时的 URL，需替换为实际 Worker 部署后的公共域名
		const workerUrl = 'voiceai.14790897.xyz';

		// 确保在 Worker 部署时进行 Webhook 注册
		if (request.method === 'GET' && new URL(request.url).pathname === '/init') {
			const webhookResponse = await registerTelegramWebhook(workerUrl, env);
			return new Response(JSON.stringify(webhookResponse), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		if (request.method !== 'POST') {
			return new Response('Invalid request method', { status: 405 });
		}

		const update = await request.json(); // 获取 Telegram 更新内容
		try {
			return await handleTelegramUpdate(update, env); // 处理 Telegram 更新
		} catch (error) {
			console.error('Error handling Telegram update:', error);
			return new Response('Internal Server Error', { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
