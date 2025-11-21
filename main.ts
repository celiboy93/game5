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
            <a href="/" class="flex flex-col items-center gap-1 text-blue-500 hover:text-blue-400 transition w-full"><span class="text-[10px] font-medium">Home</span></a>
            <a href="/2d" class="flex flex-col items-center gap-1 text-slate-500 hover:text-blue-400 transition w-full"><span class="text-[10px] font-medium">2D Live</span></a>
            <a href="/history" class="flex flex-col items-center gap-1 text-slate-500 hover:text-blue-400 transition w-full"><span class="text-[10px] font-medium">History</span></a>
            <a href="/profile" class="flex flex-col items-center gap-1 text-slate-500 hover:text-blue-400 transition w-full"><span class="text-[10px] font-medium">Profile</span></a>
        </div>
    </div>
    ` : ''}
</body>
</html>
`;

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
`;

const AdminPanel = (user: User, topUpMessage?: string) => `
${Layout("Admin Panel", `
    <div class="max-w-2xl mx-auto space-y-8">
        <h1 class="text-3xl font-bold text-yellow-400">Admin Panel</h1>
        
        <div class="glass p-6 rounded-xl border border-blue-500/30">
            <h2 class="text-xl font-bold mb-4 text-white">💰 Credit Top Up</h2>
            ${topUpMessage ? `<div class="bg-green-500/20 text-green-200 p-3 rounded mb-4">${topUpMessage}</div>` : ''}
            <form method="POST" action="/admin/topup" class="space-y-4">
                <div>
                    <label class="block text-sm text-

