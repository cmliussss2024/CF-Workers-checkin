let domain = "这里填机场域名";
let user = "这里填邮箱";
let pass = "这里填密码";
let 签到结果;
let BotToken = '';
let ChatID = '';

export default {
	// HTTP 请求处理函数保持不变
	async fetch(request, env, ctx) {
		await initializeVariables(env);
		const url = new URL(request.url);
		if (url.pathname == "/tg") {
			await sendMessage();
		} else if (url.pathname == `/${pass}`) {
			await checkin();
		}
		return new Response(签到结果, {
			status: 200,
			headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
		});
	},

	// 定时任务处理函数
	async scheduled(controller, env, ctx) {
		console.log('定时任务开始执行');
		try {
			await initializeVariables(env);
			await checkin();
			console.log('定时任务执行成功');
		} catch (error) {
			console.error('定时任务执行失败:', error);
			签到结果 = `定时任务执行失败：${error.message}`;
			await sendMessage(签到结果);
		}
	},
};

async function initializeVariables(env) {
	domain = env.JC || env.DOMAIN || domain;
	user = env.ZH || env.USER || user;
	pass = env.MM || env.PASS || pass;
	if (!domain.includes("//")) domain = `https://${domain}`;
	BotToken = env.TGTOKEN || BotToken;
	ChatID = env.TGID || ChatID;
	签到结果 = `地址：${domain.substring(0, 9)}****${domain.substring(domain.length - 5)}\n账号：${user.substring(0, 1)}****${user.substring(user.length - 5)}\n密码：${pass.substring(0, 1)}****${pass.substring(pass.length - 1)}\n\nTG 推送：${ChatID ? `${ChatID.substring(0, 1)}****${ChatID.substring(ChatID.length - 3)}` : "未启用"}`;
}

async function sendMessage(msg = "") {
	const 账号信息 = `地址：${domain}\n账号：${user}\n密码：<tg-spoiler>${pass}</tg-spoiler>`;
	const now = new Date();
	const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
	const formattedTime = beijingTime.toISOString().slice(0, 19).replace('T', ' ');
	console.log(msg);
	if (BotToken !== '' && ChatID !== '') {
		const url = `https://api.telegram.org/bot${BotToken}/sendMessage?chat_id=${ChatID}&parse_mode=HTML&text=${encodeURIComponent("执行时间：" + formattedTime + "\n" + 账号信息 + "\n\n" + msg)}`;
		return fetch(url, {
			method: 'get',
			headers: {
				'Accept': 'text/html,application/xhtml+xml,application/xml;',
				'Accept-Encoding': 'gzip, deflate, br',
				'User-Agent': 'Mozilla/5.0 Chrome/90.0.4430.72'
			}
		});
	} else if (ChatID !== "") {
		const url = `https://api.tg.090227.xyz/sendMessage?chat_id=${ChatID}&parse_mode=HTML&text=${encodeURIComponent("执行时间：" + formattedTime + "\n" + 账号信息 + "\n\n" + msg)}`;
		return fetch(url, {
			method: 'get',
			headers: {
				'Accept': 'text/html,application/xhtml+xml,application/xml;',
				'Accept-Encoding': 'gzip, deflate, br',
				'User-Agent': 'Mozilla/5.0 Chrome/90.0.4430.72'
			}
		});
	}
}

// 带重试机制的 checkin 函数
async function checkin() {
	const maxRetries = 3;
	const retryDelay = 5000;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			console.log(`[第 ${attempt} 次尝试] 开始执行签到流程...`);
			await doCheckin();
			console.log(`[第 ${attempt} 次尝试] 签到流程执行成功！`);
			await sendMessage(签到结果);
			return 签到结果;
		} catch (error) {
			console.error(`[第 ${attempt} 次尝试] 签到执行失败:`, error);
			if (attempt === maxRetries) {
				签到结果 = `签到过程发生错误 (重试 ${maxRetries} 次后失败):\n${error.message}`;
				await sendMessage(签到结果);
				return 签到结果;
			} else {
				console.log(`等待 ${retryDelay / 1000} 秒后进行重试...`);
				await new Promise(resolve => setTimeout(resolve, retryDelay));
			}
		}
	}
}

async function doCheckin() {
	if (!domain || !user || !pass) {
		throw new Error('必需的配置参数缺失');
	}

	// 登录请求
	const loginResponse = await fetch(`${domain}/auth/login`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
			'Accept': 'application/json, text/plain, */*',
			'Origin': domain,
			'Referer': `${domain}/auth/login`,
		},
		body: JSON.stringify({
			email: user,
			passwd: pass,
			remember_me: 'on',
			code: "",
		}),
	});

	console.log('登录响应状态码:', loginResponse.status);

	if (!loginResponse.ok) {
		const errorText = await loginResponse.text();
		throw new Error(`登录请求失败 (HTTP ${loginResponse.status}): ${errorText}`);
	}

	const loginJson = await loginResponse.json();
	console.log('登录响应数据:', loginJson);

	if (loginJson.ret !== 1) {
		throw new Error(`登录失败：${loginJson.msg || '未知错误'}`);
	}

	// 修复：改进 Cookie 提取逻辑
	let cookies = "";
	const setCookieHeader = loginResponse.headers.get('set-cookie');
	
	if (setCookieHeader) {
		// 按逗号分割但保留 cookie 完整性（排除 expires 中的逗号）
		const cookiePairs = [];
		const parts = setCookieHeader.split(', ');
		
		for (let part of parts) {
			// 取每个 cookie 的 name=value 部分（分号前）
			const cookiePair = part.split(';')[0].trim();
			if (cookiePair && cookiePair.includes('=')) {
				cookiePairs.push(cookiePair);
			}
		}
		cookies = cookiePairs.join('; ');
		console.log('提取的 Cookie:', cookies);
	}
	
	if (!cookies) {
		throw new Error('登录成功但未收到有效 Cookie');
	}

	// 增加等待时间确保登录状态生效
	await new Promise(resolve => setTimeout(resolve, 2000));

	// 签到请求
	const checkinResponse = await fetch(`${domain}/user/checkin`, {
		method: 'POST',
		headers: {
			'Cookie': cookies,
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
			'Accept': 'application/json, text/plain, */*',
			'Content-Type': 'application/json',
			'Origin': domain,
			'Referer': `${domain}/user/panel`,
			'X-Requested-With': 'XMLHttpRequest'
		},
	});

	console.log('签到响应状态码:', checkinResponse.status);

	const responseText = await checkinResponse.text();
	console.log('签到原始响应数据:', responseText);

	try {
		const checkinResult = JSON.parse(responseText);
		console.log('签到解析结果:', checkinResult);

		if (checkinResult.ret === 1 || checkinResult.ret === 0) {
			签到结果 = `🎉 签到结果 🎉\n ${checkinResult.msg || (checkinResult.ret === 1 ? '签到成功' : '签到失败')}`;
		} else {
			签到结果 = `🎉 签到结果 🎉\n ${checkinResult.msg || '签到结果未知'}`;
		}
	} catch (e) {
		if (responseText.includes('登录') || responseText.includes('<html') || responseText.includes('window.location')) {
			throw new Error('登录状态无效或 Cookie 未生效，返回了页面 HTML');
		}
		throw new Error(`解析签到响应 JSON 失败：${e.message}\n\n原始响应：${responseText}`);
	}
}
