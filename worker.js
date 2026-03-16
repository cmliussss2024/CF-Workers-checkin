let domain = "这里填机场域名";
let user = "这里填邮箱";
let pass = "这里填密码";
let BotToken = '';
let ChatID = '';

export default {
	async fetch(request, env, ctx) {
		await initializeVariables(env);
		const url = new URL(request.url);

		// Handle Frontend UI
		if (url.pathname === "/") {
			return new Response(HTML_TEMPLATE, {
				headers: { 'Content-Type': 'text/html;charset=UTF-8' }
			});
		}

		// Handle API routes
		if (url.pathname.startsWith("/api/")) {
			return handleApiRequest(request, url.pathname);
		}

		// Fallback for legacy /pass trigger (optional, maintaining original behavior if desired)
		if (url.pathname === `/${pass}`) {
			const res = await performCheckinWithLogs();
			return new Response(res.result, { headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
		}

		return new Response("Not Found", { status: 404 });
	},

	async scheduled(controller, env, ctx) {
		console.log('定时任务开始执行');
		try {
			await initializeVariables(env);
			const result = await performCheckinWithLogs();
			console.log('定时任务执行完成:', result.result);
			await sendMessage(result.result);
		} catch (error) {
			console.error('定时任务执行失败:', error);
			await sendMessage(`定时任务执行失败: ${error.message}`);
		}
	},
};

// --- Initialization ---
async function initializeVariables(env) {
	domain = env.JC || env.DOMAIN || domain;
	user = env.ZH || env.USER || user;
	pass = env.MM || env.PASS || pass;
	if (!domain.includes("//")) domain = `https://${domain}`;
	BotToken = env.TGTOKEN || BotToken;
	ChatID = env.TGID || ChatID;
}

// --- Security: Auth Verification ---
async function verifyAuth(request) {
	const authHeader = request.headers.get("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) return false;

	const clientHash = authHeader.split(" ")[1];

	// Reconstruct hash
	const urlObj = new URL(request.url);
	const hostname = urlObj.hostname;
	const ua = request.headers.get("User-Agent") || "";

	const rawString = hostname + pass + ua;
	const encoder = new TextEncoder();
	const data = encoder.encode(rawString);

	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const serverHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

	return clientHash === serverHash;
}

// --- API Router ---
async function handleApiRequest(request, pathname) {
	const isAuthEndpoint = pathname === "/api/login";

	// Verify Token for all except login
	if (!isAuthEndpoint && !(await verifyAuth(request))) {
		return new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401, headers: { 'Content-Type': 'application/json' }
		});
	}

	try {
		switch (pathname) {
			case "/api/login":
				if (await verifyAuth(request)) {
					return Response.json({ success: true });
				} else {
					return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401, headers: { 'Content-Type': 'application/json' } });
				}

			case "/api/info": {
				const mask = (str, isEmail = false) => {
					if (!str) return "";
					if (isEmail && str.includes("@")) {
						const [local, domainPart] = str.split("@");
						const maskPart = (s) => {
							if (s.length <= 2) return "*".repeat(s.length);
							return s[0] + "*".repeat(s.length - 2) + s[s.length - 1];
						};
						return maskPart(local) + "@" + domainPart;
					}
					if (str.length <= 2) return "*".repeat(str.length);
					return str[0] + "*".repeat(str.length - 2) + str[str.length - 1];
				};
				return Response.json({
					domain: domain,
					user: mask(user, true),
					pass: mask(pass),
					tgEnabled: !!ChatID,
					tgType: BotToken ? 'custom' : 'builtin'
				});
			}

			case "/api/checkin":
				if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
				const res = await performCheckinWithLogs();
				return Response.json(res);

			case "/api/test_tg":
				if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
				if (!ChatID) return Response.json({ success: false, message: "未配置 TG ChatID" });

				const tgRes = await sendMessage("🔔 这是一条来自动动签到管理面板的测试消息\n如果您能看到这条消息，说明TG推送配置正确！");
				if (tgRes && tgRes.ok) {
					return Response.json({ success: true, message: "消息已成功发送" });
				} else {
					const errTxt = tgRes ? await tgRes.text() : "未知网络错误";
					return Response.json({ success: false, message: `发送失败: ${errTxt}` });
				}

			default:
				return new Response("API Not Found", { status: 404 });
		}
	} catch (err) {
		return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
	}
}

// --- Cookie Helper ---
function extractCookies(response) {
	const pairs = [];
	if (response.headers.getSetCookie) {
		const setCookies = response.headers.getSetCookie();
		for (const cookie of setCookies) {
			const nameValue = cookie.split(';')[0];
			if (nameValue && nameValue.includes('=')) pairs.push(nameValue);
		}
	} else {
		const cookieHeader = response.headers.get('set-cookie');
		if (cookieHeader) {
			const parts = cookieHeader.split(/,\s*(?=[a-zA-Z0-9_-]+\s*=)/);
			for (const part of parts) {
				const nameValue = part.split(';')[0];
				if (nameValue && nameValue.includes('=')) pairs.push(nameValue);
			}
		}
	}
	return pairs;
}

function cookieMap(pairs) {
	const map = new Map();
	for (const pair of pairs) {
		const eqIdx = pair.indexOf('=');
		if (eqIdx > 0) map.set(pair.substring(0, eqIdx).trim(), pair);
	}
	return map;
}

function mergeCookies(existing, newPairs) {
	const map = cookieMap(existing);
	for (const pair of newPairs) {
		const eqIdx = pair.indexOf('=');
		if (eqIdx > 0) map.set(pair.substring(0, eqIdx).trim(), pair);
	}
	return Array.from(map.values());
}

function cookieString(pairs) {
	return pairs.join('; ');
}

function cookieNameList(pairs) {
	return pairs.map(p => p.split('=')[0]).join(', ');
}

// --- Core Checkin Logic (Wrapped to collect logs) ---
async function performCheckinWithLogs() {
	const maxRetries = 3;
	const retryDelay = 5000;
	let capturedLogs = [];
	const log = (msg) => { console.log(msg); capturedLogs.push(msg); };
	const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			log(`[第 ${attempt}/${maxRetries} 次尝试] 系统准备执行请求...`);

			if (!domain || !user || !pass) {
				throw new Error('必需的配置参数缺失 (domain/user/pass)');
			}

			// Step 1: Visit homepage to get initial session cookie
			log("访问站点获取初始会话...");
			const initResponse = await fetch(`${domain}/auth/login`, {
				method: 'GET',
				headers: {
					'User-Agent': UA,
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				},
			});
			let allCookies = extractCookies(initResponse);
			if (allCookies.length > 0) {
				log(`初始 Cookie: ${cookieNameList(allCookies)}`);
			} else {
				log("初始访问未获取到 Cookie");
			}

			// Step 2: Login (carry initial cookies so session is bound)
			log(`请求登录接口: ${domain}/auth/login`);
			const loginResponse = await fetch(`${domain}/auth/login`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': UA,
					'Accept': 'application/json, text/plain, */*',
					'Origin': domain,
					'Referer': `${domain}/auth/login`,
					'Cookie': cookieString(allCookies),
				},
				body: JSON.stringify({ email: user, passwd: pass, remember_me: 'on', code: "" }),
			});

			if (!loginResponse.ok) {
				throw new Error(`登录失败 (HTTP ${loginResponse.status}): ${await loginResponse.text()}`);
			}

			const loginJson = await loginResponse.json();
			if (loginJson.ret !== 1) {
				throw new Error(`登录校验失败: ${loginJson.msg || '未知错误'}`);
			}
			log("✓ 登录验证通过");

			// Merge login cookies with initial cookies
			const loginCookies = extractCookies(loginResponse);
			allCookies = mergeCookies(allCookies, loginCookies);
			if (allCookies.length === 0) throw new Error("未能获取到有效的 Cookie");
			log(`登录后 Cookie (${allCookies.length}): ${cookieNameList(allCookies)}`);

			// Step 3: Wait for session to be ready before checkin
			// Server-side session propagation can have delays
			log("验证会话状态...");
			const maxSessionChecks = 6;
			let sessionReady = false;
			for (let sc = 1; sc <= maxSessionChecks; sc++) {
				await new Promise(resolve => setTimeout(resolve, sc === 1 ? 1500 : 2000));
				const verifyResponse = await fetch(`${domain}/user`, {
					method: 'GET',
					headers: {
						'Cookie': cookieString(allCookies),
						'User-Agent': UA,
						'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
						'Referer': `${domain}/auth/login`,
					},
					redirect: 'manual',
				});

				const verifyStatus = verifyResponse.status;
				if (verifyStatus === 200 || verifyStatus === 304) {
					log(`✓ 会话验证通过 (第 ${sc} 次检查)`);
					sessionReady = true;
					break;
				} else if (verifyStatus >= 300 && verifyStatus < 400) {
					if (sc < maxSessionChecks) {
						log(`会话尚未就绪 (HTTP ${verifyStatus})，等待重试... (${sc}/${maxSessionChecks})`);
					} else {
						log(`会话始终未就绪 (HTTP ${verifyStatus})，已尝试 ${maxSessionChecks} 次`);
					}
				} else {
					log(`会话验证异常 (HTTP ${verifyStatus})，跳过等待`);
					sessionReady = true;
					break;
				}
			}

			if (!sessionReady) {
				throw new Error("会话验证失败: 登录成功但 Session 始终未就绪");
			}

			// Step 4: Checkin
			await new Promise(resolve => setTimeout(resolve, 1000));
			log("正在发送签到请求...");
			log(`签到使用 Cookie: ${cookieNameList(allCookies)}`);

			const checkinResponse = await fetch(`${domain}/user/checkin`, {
				method: 'POST',
				headers: {
					'Cookie': cookieString(allCookies),
					'User-Agent': UA,
					'Accept': 'application/json, text/plain, */*',
					'Origin': domain,
					'Referer': `${domain}/user`,
					'X-Requested-With': 'XMLHttpRequest'
				},
				redirect: 'manual',
			});

			const checkinSetCookies = extractCookies(checkinResponse);
			log(`签到响应状态码: ${checkinResponse.status}`);
			if (checkinSetCookies.length > 0) {
				log(`签到响应 Set-Cookie: ${cookieNameList(checkinSetCookies)}`);
			}

			// 检测重定向
			if (checkinResponse.status >= 300 && checkinResponse.status < 400) {
				const location = checkinResponse.headers.get('location') || '未知';
				// 诊断信息：打印所有发送的 cookie 值（名称+值前4字符）
				const cookieDiag = allCookies.map(p => {
					const eq = p.indexOf('=');
					const name = p.substring(0, eq);
					const val = p.substring(eq + 1);
					return `${name}=${val.substring(0, 4)}...`;
				}).join(', ');
				log(`诊断 Cookie: ${cookieDiag}`);
				throw new Error(`签到请求被重定向 (HTTP ${checkinResponse.status}) -> ${location}，Cookie/Session 失效`);
			}

			if (!checkinResponse.ok) {
				throw new Error(`签到请求失败 (HTTP ${checkinResponse.status})`);
			}

			const responseText = await checkinResponse.text();
			const contentType = checkinResponse.headers.get('content-type') || '';
			log(`签到响应 Content-Type: ${contentType}`);

			let checkinResult;
			try {
				checkinResult = JSON.parse(responseText);
			} catch (e) {
				throw new Error(`解析签到响应失败 (HTTP ${checkinResponse.status}): ${responseText.substring(0, 200)}...`);
			}

			const finalMsg = `[签到回报] ${checkinResult.msg || (checkinResult.ret === 1 ? '成功' : '失败')}`;
			log(finalMsg);

			return { success: checkinResult.ret === 1 || checkinResult.ret === 0, result: finalMsg, logs: capturedLogs };

		} catch (error) {
			log(`X ${error.message}`);
			if (attempt === maxRetries) {
				const failMsg = `重试 ${maxRetries} 次后最终放弃: ${error.message}`;
				return { success: false, result: failMsg, logs: capturedLogs };
			} else {
				log(`等待 ${retryDelay / 1000}s 后进行下一次尝试...`);
				await new Promise(resolve => setTimeout(resolve, retryDelay));
			}
		}
	}
}

// --- TG Sender ---
async function sendMessage(msg = "") {
	const 账号信息 = `地址: ${domain}\n账号: ${user}\n密码: <tg-spoiler>${pass}</tg-spoiler>`;
	const now = new Date();
	const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
	const formattedTime = beijingTime.toISOString().slice(0, 19).replace('T', ' ');
	console.log("TG Msg:", msg);

	if (BotToken !== '' && ChatID !== '') {
		const url = `https://api.telegram.org/bot${BotToken}/sendMessage?chat_id=${ChatID}&parse_mode=HTML&text=${encodeURIComponent("执行时间: " + formattedTime + "\n" + 账号信息 + "\n\n" + msg)}`;
		return fetch(url, { method: 'get' });
	} else if (ChatID !== "") {
		const url = `https://api.tg.090227.xyz/sendMessage?chat_id=${ChatID}&parse_mode=HTML&text=${encodeURIComponent("执行时间: " + formattedTime + "\n" + 账号信息 + "\n\n" + msg)}`;
		return fetch(url, { method: 'get' });
	}
	return null;
}

const HTML_TEMPLATE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>自动签到管理面板</title>
  <style>
    :root {
      --bg-color: #0f172a;
      --panel-bg: rgba(30, 41, 59, 0.7);
      --border-color: rgba(255, 255, 255, 0.1);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #10b981;
      --danger: #ef4444;
      --radius: 12px;
      --font: 'Inter', system-ui, -apple-system, sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--font);
      background-color: var(--bg-color);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
      background-image: 
        radial-gradient(circle at 15% 50%, rgba(59, 130, 246, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 85% 30%, rgba(16, 185, 129, 0.15) 0%, transparent 50%);
    }

    /* Common */
    .glass {
      background: var(--panel-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: var(--radius);
    }
    
    h1, h2, h3 { font-weight: 600; letter-spacing: -0.025em; }
    
    .hidden { display: none !important; }

    input {
      width: 100%;
      padding: 12px 16px;
      margin-bottom: 16px;
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      border-radius: 8px;
      font-size: 1rem;
      transition: all 0.2s;
    }
    input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
    }

    button {
      background: var(--accent);
      color: white;
      border: none;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      width: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 8px;
    }
    button:hover { background: var(--accent-hover); transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    button:disabled { opacity: 0.7; cursor: not-allowed; }
    
    button.secondary { background: rgba(255,255,255,0.1); }
    button.secondary:hover { background: rgba(255,255,255,0.15); }

    /* Login View */
    #login-view {
      display: flex;
      justify-content: center;
      align-items: center;
      flex: 1;
      padding: 20px;
    }
    .login-box {
      width: 100%;
      max-width: 400px;
      padding: 40px 40px 24px;
      text-align: center;
      animation: fadeIn 0.5s ease-out;
    }
    .login-box h1 { margin-bottom: 8px; font-size: 1.5rem; }
    .login-box p { color: var(--text-muted); margin-bottom: 24px; font-size: 0.9rem; }
    
    .error-msg {
      color: var(--danger);
      font-size: 0.875rem;
      margin-top: 8px;
      min-height: 18px;
    }

    /* Dashboard View */
    #dashboard-view {
      padding: 30px;
      max-width: 1400px;
      margin: 0 auto;
      width: 100%;
      display: grid;
      grid-template-columns: 350px 1fr;
      gap: 24px;
      flex: 1;
      animation: slideUp 0.4s ease-out;
    }

    @media (max-width: 900px) {
      #dashboard-view { grid-template-columns: 1fr; }
    }

    /* Left Sidebar */
    .sidebar { display: flex; flex-direction: column; gap: 20px; }
    
    .info-card { padding: 24px; }
    .info-card h2 { font-size: 1.25rem; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; }
    
    .info-group { margin-bottom: 16px; }
    .info-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
    .info-value { font-size: 1rem; font-family: monospace; background: rgba(0,0,0,0.2); padding: 8px 12px; border-radius: 6px; word-break: break-all; }
    
    .status-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
      background: rgba(16, 185, 129, 0.2);
      color: var(--success);
    }
    .status-badge.disabled { background: rgba(239, 68, 68, 0.2); color: var(--danger); }

    .actions-card { padding: 24px; display: flex; flex-direction: column; gap: 12px; }

    /* Right Console */
    .console-wrapper {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 500px;
    }
    .console-header {
      padding: 16px 24px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .console-header h2 { font-size: 1.1rem; }
    .clear-btn {
      background: transparent; padding: 4px 8px; width: auto; font-size: 0.8rem; color: var(--text-muted); border: 1px solid var(--border-color);
    }
    .clear-btn:hover { background: rgba(255,255,255,0.1); color: var(--text-main); }
    
    .console-body {
      flex: 1;
      padding: 20px;
      overflow-y: auto;
      font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
      font-size: 0.9rem;
      line-height: 1.6;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 0 0 var(--radius) var(--radius);
    }

    .log-entry { margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px; word-wrap: break-word; white-space: pre-wrap; }
    .log-time { color: var(--text-muted); font-size: 0.8em; margin-right: 12px; }
    .log-info { color: #60a5fa; }
    .log-success { color: #34d399; }
    .log-error { color: #f87171; }
    .log-warn { color: #fbbf24; }

    /* Header */
    .top-header {
      padding: 20px 30px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .logo { font-size: 1.2rem; font-weight: bold; background: linear-gradient(to right, #60a5fa, #34d399); -webkit-background-clip: text; color: transparent; }
    .logout-btn { background: transparent; color: var(--text-muted); width: auto; padding: 6px 12px; font-size: 0.9rem; }
    .logout-btn:hover { background: rgba(255,255,255,0.1); color: white; }

    /* Loading Spinner */
    .spinner {
      width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3);
      border-radius: 50%; border-top-color: white; animation: spin 0.8s linear infinite;
      display: none;
    }
    .loading .spinner { display: inline-block; }

    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body>

  <div id="login-view">
    <div class="glass login-box">
      <h1>身份验证</h1>
      <p>请输入签到账号的密码以访问控制台</p>
      
      <form id="login-form">
        <input type="password" id="pwd-input" placeholder="输入密码" required autofocus autocomplete="current-password">
        <button type="submit" id="login-btn">
          <span>登录</span>
          <div class="spinner"></div>
        </button>
        <div id="login-error" class="error-msg"></div>
      </form>
    </div>
  </div>

  <div id="app-view" class="hidden">
    <header class="top-header">
      <div class="logo">AutoCheckin Panel</div>
      <button class="logout-btn" id="logout-btn">退出登录</button>
    </header>

    <div id="dashboard-view">
      <!-- Left Sidebar -->
      <div class="sidebar">
        <div class="glass info-card">
          <h2>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            配置信息
          </h2>
          
          <div class="info-group">
            <div class="info-label">机场域名</div>
            <div class="info-value"><a id="info-domain" href="#" target="_blank" style="color: inherit; text-decoration: none;">加载中...</a></div>
          </div>
          
          <div class="info-group">
            <div class="info-label">签到账号</div>
            <div class="info-value" id="info-user">加载中...</div>
          </div>
          
          <div class="info-group">
            <div class="info-label">签到密码 (明文)</div>
            <div class="info-value" id="info-pass">加载中...</div>
          </div>
          
          <div class="info-group" style="margin-top: 24px;">
            <div class="info-label">TG 推送状态</div>
            <div style="margin-top: 8px;" id="info-tg">
              <span class="status-badge" style="background: rgba(255,255,255,0.1); color: white;">检测中...</span>
            </div>
          </div>
        </div>

        <div class="glass actions-card">
          <button id="btn-checkin">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
            <span>手动执行签到</span>
            <div class="spinner"></div>
          </button>
          <button id="btn-tg" class="secondary">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
            <span>测试 TG 推送</span>
            <div class="spinner"></div>
          </button>
        </div>
      </div>

      <!-- Right Console -->
      <div class="glass console-wrapper">
        <div class="console-header">
          <h2>运行日志</h2>
          <button class="clear-btn" id="btn-clear-log">清空</button>
        </div>
        <div class="console-body" id="console-output">
          <div class="log-entry"><span class="log-time">[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]</span><span class="log-success">控制台初始化完成...等待操作。</span></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    // Security Hash generation
    async function generateAuthHash(password) {
      const hostname = window.location.hostname;
      const ua = navigator.userAgent;
      const rawString = hostname + password + ua;
      
      const encoder = new TextEncoder();
      const data = encoder.encode(rawString);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      return hashHex;
    }

    // UI Elements
    const loginView = document.getElementById('login-view');
    const appView = document.getElementById('app-view');
    const loginForm = document.getElementById('login-form');
    const pwdInput = document.getElementById('pwd-input');
    const loginBtn = document.getElementById('login-btn');
    const loginError = document.getElementById('login-error');
    const consoleOutput = document.getElementById('console-output');

    // State
    const AUTH_KEY = 'ac_auth_token';
    let currentToken = localStorage.getItem(AUTH_KEY);

    // Logger
    function appendLog(message, type = 'info') {
      const entry = document.createElement('div');
      entry.className = 'log-entry';
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      let formattedMsg = message;
      
      if(typeof message === 'object') {
        formattedMsg = JSON.stringify(message, null, 2);
      } else {
        formattedMsg = String(message); // Remove .replace(/\\n/g, '<br>')
      }

      const timeSpan = document.createElement('span');
      timeSpan.className = 'log-time';
      timeSpan.textContent = '[' + time + ']';
      
      const msgSpan = document.createElement('span');
      msgSpan.className = 'log-' + type;
      msgSpan.textContent = formattedMsg;

      entry.appendChild(timeSpan);
      entry.appendChild(msgSpan);
      consoleOutput.appendChild(entry);
      consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }

    // API Wrapper
    async function apiCall(endpoint, options = {}) {
      if(!currentToken) throw new Error("未授权访问");
      
      const headers = { 
        'Authorization': \`Bearer \${currentToken}\`,
        ...options.headers 
      };

      try {
        const res = await fetch(\`/api\${endpoint}\`, { ...options, headers });
        if(res.status === 401) {
          logout();
          throw new Error("会话已过期或验证失败，请重新登录");
        }
        const data = await res.json();
        if(!res.ok) throw new Error(data.error || \`HTTP \${res.status}\`);
        return data;
      } catch(e) {
        throw e;
      }
    }

    // Init flow: Check token -> load dashboard OR show login
    async function init() {
      if (currentToken) {
        try {
          await loadDashboardInfo();
          showDashboard();
          appendLog("自动通过已保存的凭证恢复会话成功", "success");
        } catch (e) {
          // Token invalid
          localStorage.removeItem(AUTH_KEY);
          currentToken = null;
        }
      }
    }

    // Login Form Submit
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      loginError.textContent = '';
      loginBtn.classList.add('loading');
      loginBtn.disabled = true;

      try {
        const pwd = pwdInput.value;
        const hash = await generateAuthHash(pwd);
        
        // Verify with backend
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Authorization': \`Bearer \${hash}\` }
        });

        if(res.ok) {
          currentToken = hash;
          localStorage.setItem(AUTH_KEY, hash);
          pwdInput.value = '';
          await loadDashboardInfo();
          showDashboard();
          appendLog("您已成功登录管理面板", "success");
        } else {
          loginError.textContent = '密码错误或验证失败';
        }
      } catch (err) {
        loginError.textContent = '请求失败: ' + err.message;
      } finally {
        loginBtn.classList.remove('loading');
        loginBtn.disabled = false;
      }
    });

    function showDashboard() {
      loginView.classList.add('hidden');
      appView.classList.remove('hidden');
    }

    function logout() {
      localStorage.removeItem(AUTH_KEY);
      currentToken = null;
      appView.classList.add('hidden');
      loginView.classList.remove('hidden');
      consoleOutput.innerHTML = '';
      pwdInput.focus();
    }
    
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('btn-clear-log').addEventListener('click', () => { consoleOutput.innerHTML = ''; });

    // Load left panel info
    async function loadDashboardInfo() {
      const data = await apiCall('/info');
      const domainElem = document.getElementById('info-domain');
      domainElem.textContent = data.domain;
      domainElem.href = data.domain.startsWith('http') ? data.domain : 'https://' + data.domain;
      document.getElementById('info-user').textContent = data.user;
      document.getElementById('info-pass').textContent = data.pass; // plaintext requirement
      
      const tgElem = document.getElementById('info-tg');
      if (data.tgEnabled) {
        tgElem.innerHTML = \`<span class="status-badge">\${data.tgType === 'custom' ? '✅ 启用 (自定义Bot)' : '✅ 启用 (内置Bot)'}</span>\`;
      } else {
        tgElem.innerHTML = \`<span class="status-badge disabled">❌ 未启用</span>\`;
      }
    }

    // Actions
    document.getElementById('btn-checkin').addEventListener('click', async function() {
      this.classList.add('loading');
      this.disabled = true;
      appendLog("==== 开始手动触发签到 ====", "info");
      
      try {
        const data = await apiCall('/checkin', { method: 'POST' });
        appendLog(data.result || data.message, data.success ? "success" : "warn");
        if(data.logs && data.logs.length > 0) {
           // 过滤掉已经在 summary 中显示的最后一条日志 (即 result)
           data.logs.filter(l => l !== data.result).forEach(l => appendLog("> " + l, "info"));
        }
      } catch (err) {
        appendLog("签到执行异常: " + err.message, "error");
      } finally {
        this.classList.remove('loading');
        this.disabled = false;
        appendLog("==== 签到流程结束 ====\\n", "info");
      }
    });

    document.getElementById('btn-tg').addEventListener('click', async function() {
      this.classList.add('loading');
      this.disabled = true;
      appendLog("正在发送 TG 测试消息...", "info");
      
      try {
        const data = await apiCall('/test_tg', { method: 'POST' });
        appendLog("TG推送结果: " + data.message, data.success ? "success" : "error");
      } catch (err) {
        appendLog("TG推送调用异常: " + err.message, "error");
      } finally {
        this.classList.remove('loading');
        this.disabled = false;
      }
    });

    // Start
    init();
  </script>
</body>
</html>
`;
