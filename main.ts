import { Hono } from "https://deno.land/x/hono@v4.1.6/mod.ts";
import { upgradeWebSocket } from "https://deno.land/std@0.224.0/http/server.ts";
import { getCookie, setCookie, deleteCookie as honoDeleteCookie } from "https://deno.land/x/hono@v4.1.6/helper/cookie/index.ts";

// =========================================================================
// 1. DATABASE & TYPES (Deno KV)
// =========================================================================

// --- Types ---
interface User {
    username: string;
    passwordHash: string;
    balance: number;
    isAdmin: boolean;
    createdAt: number;
}

interface TwoDBet { 
    id: string; 
    username: string; 
    number: string; 
    amount: number; 
    date: string; 
    session: "Morning" | "Evening"; 
    status: "pending" | "win" | "lose"; 
    timestamp: number; 
}

interface TwoDResult { date: string; time: string; twod: string; session: "Morning" | "Evening"; }

// --- KV Initialization ---
const kv = await Deno.openKv();

// --- DB Functions ---

// Password Hashing (SHA-256 - Deno Native)
async function hashPassword(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + "2d-salt-2025");
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getUser(username: string): Promise<User | null> {
    const res = await kv.get<User>(["users", username]);
    return res.value;
}

async function saveUser(user: User): Promise<void> {
    await kv.set(["users", user.username], user);
}

// Session Management
async function createSession(username: string, maxAgeSeconds: number = 86400): Promise<string> {
    const sessionId = crypto.randomUUID();
    await kv.set(["sessions", sessionId], username, { expireIn: maxAgeSeconds * 1000 });
    return sessionId;
}

async function getSession(sessionId: string): Promise<string | null> {
    const res = await kv.get<string>(["sessions", sessionId]);
    return res.value;
}

async function deleteSession(sessionId: string): Promise<void> {
    await kv.delete(["sessions", sessionId]);
}

// 2D Results
async function saveResult(date: string, session: "Morning" | "Evening", twod: string, time: string): Promise<void> {
    const result: TwoDResult = { date, session, twod, time };
    await kv.set(["results", date, session], result);
}

async function getResult(date: string, session: "Morning" | "Evening"): Promise<TwoDResult | null> {
    const res = await kv.get<TwoDResult>(["results", date, session]);
    return res.value;
}

async function getRecentResults(limit: number = 10): Promise<TwoDResult[]> {
    const results: TwoDResult[] = [];
    const iter = kv.list<TwoDResult>({ prefix: ["results"] }, { limit, reverse: true });
    for await (const entry of iter) {
        results.push(entry.value);
    }
    return results;
}

async function process2DWinnings(winningNumber: string, session: "Morning" | "Evening", multiplier: number): Promise<number> {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Yangon" });
    const iter = kv.list<TwoDBet>({ prefix: ["2d_bets", today] });
    let winCount = 0;
    for await (const entry of iter) {
        const bet = entry.value;
        if (bet.status === 'pending' && bet.session === session) {
            const isWin = bet.number === winningNumber;
            const newStatus = isWin ? 'win' : 'lose';
            let atomic = kv.atomic().set(entry.key, { ...bet, status: newStatus });
            if (isWin) {
                const user = await getUser(bet.username);
                if (user) {
                    const payout = bet.amount * multiplier;
                    atomic = atomic.set(["users", bet.username], { ...user, balance: user.balance + payout });
                }
            }
            const res = await atomic.commit();
            if (res.ok && isWin) {
                // Simplified history logging for new app
                winCount++;
            }
        }
    }
    return winCount;
}


// =========================================================================
// 2. UI LAYOUT & COMPONENTS
// =========================================================================

const Layout = (title: string, content: string, user?: User) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: sans-serif; background-color: #0f172a; color: #e2e8f0; }
        .glass { background: rgba(30, 41, 59, 0.85); backdrop-filter: blur(12px); }
        .loader-sm { border: 3px solid rgba(255, 255, 255, 0.3); width: 24px; height: 24px; border-radius: 50%; border-left-color: #ffffff; animation: spin 0.8s linear infinite; } 
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .bottom-nav-container { background: #0f172a; border-top: 1px solid #334155; box-shadow: 0 -4px 20px rgba(0,0,0,0.4); }
    </style>
</head>
<body class="min-h-screen flex flex-col relative pb-24">
    <nav class="glass sticky top-0 z-40 border-b border-slate-700">
        <div class="max-w-7xl mx-auto px-4 py-3 flex justify-between items-center">
            <a href="/" class="text-lg font-extrabold text-blue-400 uppercase">2D Live Bet</a>
            <div class="flex gap-3 items-center">
                ${user ? `
                    <span class="text-sm text-green-400 font-bold">${user.balance.toLocaleString()} Ks</span>
                    ${user.isAdmin ? '<a href="/admin" class="text-yellow-400 text-sm">Admin</a>' : ''}
                    <a href="/logout" class="text-sm text-red-400">Logout</a>
                ` : `<a href="/login" class="text-sm text-slate-300">Login</a>`}
            </div>
        </div>
    </nav>
    <main class="flex-grow container mx-auto px-4 py-6">
        ${content}
    </main>
    ${user ? `
    <div class="md:hidden fixed bottom-0 left-0 w-full z-[50] bottom-nav-container">
        <div class="flex justify-around items-center py-3">
            <a href="/2d" class="flex flex-col items-center gap-1 text-blue-500 hover:text-blue-400 transition w-full"><span class="text-[10px] font-medium">2D Live</span></a>
            <a href="/history" class="flex flex-col items-center gap-1 text-slate-500 hover:text-blue-400 transition w-full"><span class="text-[10px] font-medium">History</span></a>
            <a href="/profile" class="flex flex-col items-center gap-1 text-slate-500 hover:text-blue-400 transition w-full"><span class="text-[10px] font-medium">Profile</span></a>
        </div>
    </div>
    ` : ''}
</body>
</html>
`;

// 🔑 FIX: AuthForm HTML structure ensured to be complete and safely closed
const AuthForm = (type: "login" | "register", error?: string) => `
<div class="max-w-md mx-auto glass p-8 rounded-2xl shadow-2xl mt-10 border border-slate-600">
    <h2 class="text-3xl font-bold text-center mb-6 text-white uppercase">${type}</h2>
    ${error ? `<div class="bg-red-500/20 border border-red-500 text-red-200 p-3 rounded mb-4 text-center">${error}</div>` : ''}
    <form method="POST" action="/${type}" class="space-y-4">
        <div>
            <label class="block text-sm text-slate-400 mb-1">Username</label>
            <input type="text" name="username" required class="w-full bg-slate-800 border border-slate-600 rounded-lg p-3 text-white">
        </div>
        <div>
            <label class="block text-sm text-slate-400 mb-1">Password</label>
            <input type="password" name="password" required class="w-full bg-slate-800 border border-slate-600 rounded-lg p-3 text-white">
        </div>
        <button class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-lg">${type}</button>
    </form>
    <p class="mt-4 text-center text-slate-400 text-sm">
        ${type === 'login' ? 'No account? <a href="/register" class="text-blue-400">Register</a>' : 'Have an account? <a href="/login" class="text-blue-400">Login</a>'}
    </p>
</div>
`; // FINAL CLOSING BACKTICK

const AdminPanel = (user: User, topUpMessage?: string) => `
${Layout("Admin Panel", `
    <div class="max-w-2xl mx-auto space-y-8">
        <h1 class="text-3xl font-bold text-yellow-400">Admin Panel</h1>
        
        <div class="glass p-6 rounded-xl border border-blue-500/30">
            <h2 class="text-xl font-bold mb-4 text-white">💰 Credit Top Up</h2>
            ${topUpMessage ? `<div class="bg-green-500/20 text-green-200 p-3 rounded mb-4">${topUpMessage}</div>` : ''}
            <form method="POST" action="/admin/topup" class="space-y-4">
                <div>
                    <label class="block text-sm text-slate-400 mb-1">Username</label>
                    <input type="text" name="username" required class="w-full bg-slate-800 border border-slate-600 rounded-lg p-3 text-white">
                </div>
                <div>
                    <label class="block text-sm text-slate-400 mb-1">Amount (Ks)</label>
                    <input type="number" name="amount" required class="w-full bg-slate-800 border border-slate-600 rounded-lg p-3 text-white">
                </div>
                <button class="w-full bg-green-600 hover:bg-green-500 text-white font-bold py-3 rounded-lg">Top Up Credit</button>
            </form>
        </div>

        <div class="glass p-6 rounded-xl border border-red-500/30">
            <h2 class="text-xl font-bold mb-4 text-white">🎰 2D Result Management</h2>
            <form method="POST" action="/admin/result" class="space-y-4">
                <div>
                    <label class="block text-sm text-slate-400 mb-1">Winning 2D Number</label>
                    <input type="text" name="twod" maxlength="2" required class="w-full bg-slate-800 border border-slate-600 rounded-lg p-3 text-white text-3xl font-bold text-center">
                </div>
                <div class="flex gap-4">
                    <div class="flex-1">
                        <label class="block text-sm text-slate-400 mb-1">Session</label>
                        <select name="session" class="w-full bg-slate-800 border border-slate-600 rounded-lg p-3 text-white">
                            <option value="Morning">Morning</option>
                            <option value="Evening">Evening</option>
                        </select>
                    </div>
                    <div class="flex-1">
                        <label class="block text-sm text-slate-400 mb-1">Time (e.g., 12:01 PM)</label>
                        <input type="text" name="time" value="${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}" required class="w-full bg-slate-800 border border-slate-600 rounded-lg p-3 text-white">
                    </div>
                </div>
                <button class="w-full bg-red-600 hover:bg-red-500 text-white font-bold py-3 rounded-lg">Set Result & Process Payout</button>
            </form>
        </div>
        
    </div>
`, user)}
`;

const TwoDPage = (user: User, bets: TwoDBet[], recentResults: TwoDResult[]) => {
    let betHistoryHtml = ''; 
    if(bets.length === 0) { 
        betHistoryHtml = '<div class="text-center p-4 text-slate-500 text-sm">No active bets today.</div>'; 
    } else { 
        bets.forEach(b => { 
            let statusColor = 'text-yellow-400'; 
            if(b.status === 'win') statusColor = 'text-green-400'; 
            if(b.status === 'lose') statusColor = 'text-red-400'; 
            betHistoryHtml += `<div class="flex justify-between items-center p-3 border-b border-slate-700 last:border-0"><div class="text-xs text-slate-400">${b.session} <br> ${new Date(b.timestamp).toLocaleTimeString("en-US", { timeZone: "Asia/Yangon" })}</div><div class="font-bold text-white text-lg">${b.number}</div><div class="text-right"><div class="text-green-400 text-sm">${b.amount} Ks</div><div class="text-[10px] uppercase ${statusColor}">${b.status}</div></div></div>`; 
        }); 
    } 

    let historyHtml = '';
    if (recentResults.length === 0) {
        historyHtml = '<div class="p-4 text-center text-slate-500 text-sm">No recent results.</div>';
    } else {
        recentResults.forEach(r => {
            historyHtml += `<div class="flex justify-between items-center px-4 py-3 border-b border-slate-700 last:border-b-0">
                <div class="text-xs text-slate-400">${r.date}</div>
                <div class="text-sm text-white font-bold">${r.session} (${r.time})</div>
                <div class="font-bold text-3xl text-yellow-400">${r.twod}</div>
            </div>`;
        });
    }

    return Layout("2D Live", `
    <div class="max-w-md mx-auto space-y-6">
        <div class="glass p-6 rounded-2xl border border-yellow-500/30 text-center">
            <h2 class="text-lg font-bold text-slate-300 uppercase mb-2">Live Result (Mock)</h2>
            <div class="text-8xl font-black text-yellow-400 drop-shadow-xl mb-4" id="live-2d-num">--</div>
            <div class="text-sm text-slate-500 font-mono">Updated: <span id="live-time">--:--:--</span></div>
        </div>

        <div class="glass p-6 rounded-2xl border border-blue-500/30">
            <h3 class="text-lg font-bold text-white mb-4">🎰 Place Bet</h3>
            <form onsubmit="return handle2DBet(event)" class="space-y-3">
                <div class="flex gap-3">
                    <input name="number" type="text" maxlength="2" required class="flex-1 bg-slate-900 border border-slate-600 rounded-lg p-3 text-white text-center text-lg font-bold" placeholder="00-99">
                    <input name="amount" type="number" min="100" required class="flex-1 bg-slate-900 border border-slate-600 rounded-lg p-3 text-white text-center text-lg font-bold" placeholder="Amount (Ks)">
                </div>
                <button class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-xl">Bet Now</button>
            </form>
        </div>

        <div class="glass rounded-xl overflow-hidden border border-slate-700/50">
            <div class="px-4 py-3 bg-slate-800/50 border-b border-slate-700 text-slate-300 font-bold text-sm uppercase">My Bets (Today)</div>
            <div class="max-h-48 overflow-y-auto">${betHistoryHtml}</div>
        </div>

        <div class="glass rounded-xl overflow-hidden border border-slate-700/50">
            <div class="px-4 py-3 bg-slate-800/50 border-b border-slate-700 text-slate-300 font-bold text-sm uppercase">Recent Results</div>
            <div id="history-list" class="max-h-64 overflow-y-auto">${historyHtml}</div>
        </div>
    </div>

    <script>
        function handle2DBet(e) {
            e.preventDefault();
            const btn = e.target.querySelector('button');
            const originalText = btn.innerText;
            btn.innerHTML = '<div class="loader-sm mx-auto"></div>';
            btn.disabled = true;
            const formData = new FormData(e.target);
            const data = Object.fromEntries(formData.entries());

            // Simple validation
            const num = data.number.trim();
            if (num.length !== 2 || isNaN(num)) {
                alert("Invalid 2D number format (must be 00-99)");
                btn.innerText = originalText;
                btn.disabled = false;
                return;
            }

            fetch('/api/2d/bet', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            })
            .then(res => res.json())
            .then(result => {
                alert(result.message || "Bet placed!");
                if (result.success) {
                     window.location.reload();
                }
            })
            .catch(() => alert("Connection Error"))
            .finally(() => {
                btn.innerText = originalText;
                btn.disabled = false;
            });
        }
        
        document.addEventListener("DOMContentLoaded", () => {
            // Mock Live Update (Replace with WebSocket if needed)
            const liveNum = document.getElementById('live-2d-num'); 
            const liveTime = document.getElementById('live-time');
            if(liveNum) { 
                setInterval(() => { 
                    const now = new Date();
                    const twod = (Math.floor(Math.random() * 99) + 1).toString().padStart(2, '0');
                    liveNum.innerText = twod;
                    liveTime.innerText = now.toLocaleTimeString();
                }, 10000); // Updates every 10 seconds (Mock)
            }
        });
    </script>
`, user);
}

// =========================================================================
// 3. HONO APP ROUTES (Server Logic)
// =========================================================================

const app = new Hono();

// --- Middleware: Session Check ---
async function getSessionUser(c: any): Promise<User | null> {
    const sessionId = getCookie(c, "session_id");
    if (!sessionId) return null;
    try {
        const username = await getSession(sessionId);
        if (!username) return null;
        return await getUser(username);
    } catch (e) {
        console.error("Session/User retrieval failed:", e);
        honoDeleteCookie(c, "session_id");
        return null;
    }
}


// --- HOMEPAGE / ROOT ROUTE ---
app.get("/", (c) => {
    return c.redirect("/login");
});


// --- AUTH ROUTES ---
app.get("/login", async (c) => {
    const user = await getSessionUser(c);
    if(user) return c.redirect("/2d");
    return c.html(Layout("Login", AuthForm("login")));
});
app.get("/register", (c) => c.html(Layout("Register", AuthForm("register"))));

app.post("/register", async (c) => {
    const body = await c.req.parseBody();
    const username = body.username as string;
    const password = body.password as string;
    
    if (!username || !password || username.length < 3 || password.length < 6) {
        return c.html(Layout("Register", AuthForm("register", "Invalid username or password format.")));
    }
    const existing = await getUser(username);
    if (existing) {
        return c.html(Layout("Register", AuthForm("register", "Username already taken.")));
    }

    const passwordHash = await hashPassword(password);
    const isFirstUser = (await kv.list({ prefix: ["users"] }).next()).done;

    const newUser: User = { 
        username, 
        passwordHash, 
        balance: 0, 
        isAdmin: isFirstUser, // First user is admin
        createdAt: Date.now()
    };
    await saveUser(newUser);

    const sessionId = await createSession(newUser.username);
    setCookie(c, "session_id", sessionId);
    return c.redirect("/2d");
});

app.post("/login", async (c) => {
    const body = await c.req.parseBody();
    const username = body.username as string;
    const password = body.password as string;
    
    if (!username || !password) {
        return c.html(Layout("Login", AuthForm("login", "Missing username or password.")));
    }

    const user = await getUser(username);
    if (!user) {
        return c.html(Layout("Login", AuthForm("login", "Invalid credentials.")));
    }

    const inputHash = await hashPassword(password);
    
    if (user.passwordHash !== inputHash) {
         return c.html(Layout("Login", AuthForm("login", "Invalid credentials.")));
    }

    const sessionId = await createSession(user.username);
    setCookie(c, "session_id", sessionId);
    return c.redirect("/2d");
});

app.get("/logout", async (c) => {
    const sid = getCookie(c, "session_id");
    if(sid) await deleteSession(sid);
    honoDeleteCookie(c, "session_id");
    return c.redirect("/login");
});


// --- ADMIN ROUTES ---
app.get("/admin", async (c) => {
    const user = await getSessionUser(c);
    if (!user || !user.isAdmin) return c.redirect("/login");
    return c.html(AdminPanel(user));
});

app.post("/admin/topup", async (c) => {
    const user = await getSessionUser(c);
    if (!user || !user.isAdmin) return c.text("Unauthorized", 403);
    
    const body = await c.req.parseBody();
    const targetUsername = body.username as string;
    const amount = Number(body.amount);
    
    const targetUser = await getUser(targetUsername);
    if (!targetUser || isNaN(amount) || amount <= 0) {
        return c.html(AdminPanel(user, "Error: Invalid user or amount."));
    }

    const key = ["users", targetUsername];
    const res = await kv.atomic().check(await kv.get(key)).set(key, { 
        ...targetUser, 
        balance: targetUser.balance + amount 
    }).commit();

    if (!res.ok) {
         return c.html(AdminPanel(user, "Error: Top-up failed due to transaction conflict."));
    }
    
    return c.html(AdminPanel(user, `Successfully added ${amount.toLocaleString()} Ks to ${targetUsername}.`));
});

app.post("/admin/result", async (c) => {
    const user = await getSessionUser(c);
    if (!user || !user.isAdmin) return c.text("Unauthorized", 403);
    
    const body = await c.req.parseBody();
    const twod = (body.twod as string).trim();
    const session = body.session as "Morning" | "Evening";
    const time = (body.time as string).trim();
    
    if (twod.length !== 2 || isNaN(Number(twod))) {
        return c.html(AdminPanel(user, "Error: Invalid 2D number."));
    }

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Yangon" });
    
    // 1. Save Result
    await saveResult(today, session, twod, time);
    
    // 2. Process Payouts (Simplified - assuming a fixed 80x multiplier)
    const multiplier = 80;
    const count = await process2DWinnings(twod, session, multiplier);

    return c.html(AdminPanel(user, `Result ${twod} set for ${session}. Paid ${count} winning bets.`));
});


// --- 2D LIVE & BETTING ROUTES ---
app.get("/2d", async (c) => {
    const user = await getSessionUser(c);
    if (!user) return c.redirect("/login");
    
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Yangon" });
    
    // Fetch user's bets for today
    const bets: TwoDBet[] = [];
    const betsIter = kv.list<TwoDBet>({ prefix: ["2d_bets", today, user.username] });
    for await (const entry of betsIter) bets.push(entry.value);

    // Fetch recent results for history display
    const recentResults = await getRecentResults(10);
    
    return c.html(TwoDPage(user, bets.sort((a,b) => b.timestamp - a.timestamp), recentResults));
});

app.post("/api/2d/bet", async (c) => {
    const user = await getSessionUser(c);
    if (!user) return c.json({ success: false, message: "Unauthorized" }, 401);
    
    const { number, amount: rawAmount } = await c.req.json();
    const amount = Number(rawAmount);
    
    if (!number || number.length !== 2 || isNaN(Number(number)) || isNaN(amount) || amount < 100) {
        return c.json({ success: false, message: "Invalid number or amount (Min 100 Ks)." }, 400);
    }
    if (user.balance < amount) {
        return c.json({ success: false, message: "Insufficient Balance." }, 400);
    }

    // Determine session (Simplified logic)
    const now = new Date().toLocaleString("en-US", { timeZone: "Asia/Yangon" });
    const dateObj = new Date(now);
    const hour = dateObj.getHours();
    
    let session: "Morning" | "Evening" | null = null;
    if (hour < 12) session = "Morning";
    else if (hour < 16) session = "Evening"; // Assuming evening closes around 4PM
    else return c.json({ success: false, message: "Market Closed for the day." }, 400);
    
    const today = dateObj.toLocaleDateString("en-CA", { timeZone: "Asia/Yangon" });

    // 1. Atomic Deduction
    const res = await kv.atomic().check(await kv.get(["users", user.username])).set(["users", user.username], { 
        ...user, 
        balance: user.balance - amount 
    }).commit();

    if (!res.ok) {
         return c.json({ success: false, message: "Transaction conflict. Try again." }, 500);
    }

    // 2. Save Bet
    const bet: TwoDBet = {
        id: crypto.randomUUID(), 
        username: user.username, 
        number, 
        amount, 
        date: today, 
        session, 
        status: "pending", 
        timestamp: Date.now()
    };
    await kv.set(["2d_bets", today, user.username, bet.id], bet);

    return c.json({ success: true, message: `Successfully placed ${number} for ${amount} Ks.` });
});


// --- History Route (Simple Redirect for Now) ---
app.get("/history", async (c) => {
    const user = await getSessionUser(c);
    if (!user) return c.redirect("/login");
    // This is a simple placeholder. You can expand this route later.
    return c.redirect("/2d");
});

// --- Profile Route (Mock) ---
app.get("/profile", async (c) => {
     const user = await getSessionUser(c);
     if (!user) return c.redirect("/login");
     
     const content = `<div class="max-w-md mx-auto glass p-8 rounded-2xl text-center border border-slate-600">
        <h2 class="text-3xl font-bold text-white mb-2">${user.username}</h2>
        <p class="text-green-400 text-xl font-bold">${user.balance.toLocaleString()} Ks</p>
        <p class="text-slate-400 mt-4">Profile details here.</p>
        <a href="/logout" class="mt-4 inline-block bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg">Logout</a>
     </div>`;
     return c.html(Layout("Profile", content, user));
});


// --- Error Handling ---
app.onError((err, c) => {
    console.error("GLOBAL ERROR CATCH:", err);
    // Force redirect to prevent infinite loop/crash on UI pages
    return c.text(`Internal Server Error: ${err.message}`, 500);
});


// --- SERVER START ---
Deno.serve(app.fetch);

