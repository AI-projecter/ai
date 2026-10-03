const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let authMode = "login";
let conversationId = null;
let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let analyser = null;
let sourceNode = null;
let stream = null;
let recording = false;
let silenceTimer = null;
let lastVoiceAt = 0;
let visualFrame = null;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

async function api(url, options={}) {
  const r = await fetch(url, {credentials:"same-origin", ...options});
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data.detail || data.error || `Request failed (${r.status})`);
  return data;
}

function setTyping(v) {
  $("#typing").classList.toggle("hidden", !v);
}

function scrollMessages() {
  const box = $("#messages");
  requestAnimationFrame(() => box.scrollTop = box.scrollHeight);
}

function addMessage(role, type, content, extra={}) {
  const row = document.createElement("div");
  row.className = `message ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (role === "assistant") {
    const label = document.createElement("div");
    label.className = "ai-label";
    label.textContent = "AI SPHERE";
    bubble.appendChild(label);
  }

  if (type === "image" && extra.image) {
    const img = document.createElement("img");
    img.className = "msg-image";
    img.src = extra.image;
    img.alt = "Generated image";
    bubble.appendChild(img);
    const desc = document.createElement("div");
    desc.className = "description";
    desc.textContent = content || "";
    bubble.appendChild(desc);
  } else if (type === "weather" && extra.weather) {
    bubble.appendChild(renderWeather(extra.weather));
    const desc = document.createElement("div");
    desc.className = "description";
    desc.textContent = content || "";
    desc.style.marginTop = "10px";
    bubble.appendChild(desc);
  } else if (type === "html" && extra.file_id) {
    const p = document.createElement("div");
    p.textContent = content || "HTML file created.";
    bubble.appendChild(p);

    const download = document.createElement("a");
    download.className = "download";
    download.href = `/api/files/${extra.file_id}/download`;
    download.download = "ai-generated-page.html";
    download.textContent = "⬇ Download HTML";
    bubble.appendChild(download);

    const iframe = document.createElement("iframe");
    iframe.className = "preview";
    iframe.src = `/api/files/${extra.file_id}/preview`;
    iframe.sandbox = "allow-scripts";
    bubble.appendChild(iframe);
  } else {
    bubble.textContent = content || "";
  }

  row.appendChild(bubble);
  $("#messages").appendChild(row);
  scrollMessages();
  return row;
}

function renderWeather(w) {
  const card = document.createElement("div");
  card.className = "weather-card";
  const icon = w.icon ? `https://openweathermap.org/img/wn/${w.icon}@2x.png` : "";
  card.innerHTML = `
    <div class="weather-main">
      <div>
        <div class="weather-place">${escapeHtml(w.name || "Unknown location")}${w.country ? ", " + escapeHtml(w.country) : ""}</div>
        <div class="weather-temp">${Math.round(w.temp ?? 0)}°C</div>
        <div class="weather-desc">${escapeHtml(w.description || "")}</div>
      </div>
      ${icon ? `<img class="weather-icon" src="${icon}" alt="">` : ""}
    </div>
    <div class="weather-stats">
      <div class="stat"><small>Feels like</small><b>${Math.round(w.feels_like ?? 0)}°C</b></div>
      <div class="stat"><small>Humidity</small><b>${w.humidity ?? "—"}%</b></div>
      <div class="stat"><small>Wind</small><b>${w.wind ?? "—"} m/s</b></div>
    </div>`;
  return card;
}

function showAuthError(msg) { $("#authError").textContent = msg || ""; }

async function checkSession() {
  try {
    const me = await api("/api/me");
    if (me.authenticated) {
      showApp(me.username);
      await loadHistory();
    } else showAuth();
  } catch { showAuth(); }
}

function showAuth() {
  $("#auth").classList.remove("hidden");
  $("#app").classList.add("hidden");
}

function showApp(username) {
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#userLabel").textContent = "@" + username;
}

$$(".tab").forEach(btn => btn.addEventListener("click", () => {
  authMode = btn.dataset.auth;
  $$(".tab").forEach(x => x.classList.toggle("active", x === btn));
  $("#authButton").textContent = authMode === "login" ? "Sign in" : "Create account";
  showAuthError("");
}));

$("#authButton").addEventListener("click", async () => {
  showAuthError("");
  try {
    const data = await api(authMode === "login" ? "/api/login" : "/api/register", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({username:$("#username").value.trim(), password:$("#password").value})
    });
    showApp(data.username);
    await loadHistory();
  } catch(e) { showAuthError(e.message); }
});

$("#password").addEventListener("keydown", e => { if(e.key === "Enter") $("#authButton").click(); });
$("#logout").addEventListener("click", async () => { await api("/api/logout",{method:"POST"}); location.reload(); });

function newConversation() {
  conversationId = null;
  $("#messages").innerHTML = "";
  $("#conversationTitle").textContent = "New conversation";
}
$("#newChat").addEventListener("click", newConversation);

async function loadHistory() {
  const items = await api("/api/history");
  $("#history").innerHTML = "";
  for (const item of items) {
    const b = document.createElement("button");
    b.className = "history-item";
    b.textContent = item.title || "Conversation";
    b.onclick = () => loadConversation(item.conversation_id);
    $("#history").appendChild(b);
  }
}

async function loadConversation(id) {
  conversationId = id;
  const rows = await api(`/api/conversation/${encodeURIComponent(id)}`);
  $("#messages").innerHTML = "";
  for (const r of rows) addMessage(r.role, r.type, r.content, r.extra || {});
  $("#conversationTitle").textContent = rows.find(x=>x.role==="user")?.content?.slice(0,50) || "Conversation";
  $("#history").classList.remove("open");
}

async function sendText(text=null) {
  const value = (text ?? $("#input").value).trim();
  if (!value) return;
  $("#input").value = "";
  $("#input").style.height = "auto";
  addMessage("user","user",value);
  setTyping(true);
  try {
    const data = await api("/api/chat", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({message:value, conversation_id:conversationId})
    });
    conversationId = data.conversation_id;
    $("#conversationTitle").textContent = value.slice(0,50);
    if (data.type === "image") {
      addMessage("assistant","image",data.description,{image:data.image});
      speak(data.description);
    } else if (data.type === "weather") {
      addMessage("assistant","weather",data.text,{weather:data.weather});
      speak(data.text);
    } else if (data.type === "html") {
      addMessage("assistant","html",data.text,{file_id:data.file_id});
      speak(data.text);
    } else {
      addMessage("assistant","chat",data.text);
      speak(data.text);
    }
    await loadHistory();
  } catch(e) {
    addMessage("assistant","chat","Sorry, something went wrong: " + e.message);
  } finally { setTyping(false); }
}

$("#send").addEventListener("click", () => sendText());
$("#input").addEventListener("keydown", e => {
  if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); sendText(); }
});
$("#input").addEventListener("input", e => {
  e.target.style.height="auto";
  e.target.style.height=Math.min(e.target.scrollHeight,140)+"px";
});

async function startRecording() {
  if (recording) return stopRecording();
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio:true});
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if(e.data.size) audioChunks.push(e.data); };
    mediaRecorder.onstop = processRecording;
    mediaRecorder.start(100);
    recording = true;
    lastVoiceAt = performance.now();
    $("#sphere").classList.add("recording");
    $("#sphereStatus").textContent = "Listening… tap again to send";
    audioContext = new AudioContext();
    sourceNode = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    sourceNode.connect(analyser);
    monitorAudio();
  } catch(e) {
    $("#sphereStatus").textContent = "Microphone permission is required";
  }
}

function monitorAudio() {
  if(!recording || !analyser) return;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum=0;
  for(const x of data){ const n=(x-128)/128; sum += n*n; }
  const rms = Math.sqrt(sum/data.length);
  const power = Math.min(1, rms*4.2);
  $("#sphere").style.transform = `scale(${1 + power*.12})`;
  $("#sphere").style.boxShadow = `0 0 ${35+power*55}px rgba(105,145,255,${.55+power*.4}), 0 0 ${90+power*100}px rgba(76,91,255,${.15+power*.3}), inset -18px -22px 35px #0008`;
  if(power > .035) lastVoiceAt = performance.now();
  if(performance.now()-lastVoiceAt > 1300) stopRecording();
  visualFrame = requestAnimationFrame(monitorAudio);
}

function stopRecording() {
  if(!recording) return;
  recording = false;
  cancelAnimationFrame(visualFrame);
  clearTimeout(silenceTimer);
  $("#sphere").classList.remove("recording");
  $("#sphere").style.transform = "";
  $("#sphereStatus").textContent = "Processing…";
  if(mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  if(stream) stream.getTracks().forEach(t=>t.stop());
  if(audioContext) audioContext.close();
}

async function processRecording() {
  const blob = new Blob(audioChunks, {type:"audio/webm"});
  try {
    const form = new FormData();
    form.append("file", blob, "voice.webm");
    const data = await api("/api/transcribe", {method:"POST", body:form});
    if(data.text?.trim()) await sendText(data.text.trim());
  } catch(e) {
    addMessage("assistant","chat","Voice transcription failed: " + e.message);
  } finally { $("#sphereStatus").textContent = "Tap to speak"; }
}
$("#sphereWrap").addEventListener("click", startRecording);

async function speak(text) {
  if(!text) return;
  const lang = /[\u0400-\u04FF]/.test(text) ? "ru" : (/[\u0600-\u06FF]/.test(text) ? "ar" : "en");
  try {
    const data = await api("/api/tts", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({text:text.slice(0,200), language:lang})
    });
    const bytes = Uint8Array.from(atob(data.audio || ""), c => c.charCodeAt(0));
    const blob = new Blob([bytes], {type:"audio/wav"});
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    await audio.play();
    audio.onended = () => URL.revokeObjectURL(url);
  } catch {
    // Current Groq Orpheus documentation does not list Russian TTS.
    // Use the browser's local voice only as a graceful fallback.
    if("speechSynthesis" in window) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang === "ru" ? "ru-RU" : lang === "ar" ? "ar-SA" : "en-US";
      speechSynthesis.speak(u);
    }
  }
}

function openWeather() { $("#weatherPanel").classList.remove("hidden"); }
$("#weatherOpen").addEventListener("click", openWeather);
$("#weatherClose").addEventListener("click", () => $("#weatherPanel").classList.add("hidden"));
$("#weatherSearch").addEventListener("click", async () => {
  const q = $("#weatherInput").value.trim();
  if(!q) return;
  $("#weatherResult").textContent = "Loading…";
  try {
    const data = await api("/api/chat", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({message:`weather in ${q}`, conversation_id:conversationId})
    });
    conversationId = data.conversation_id;
    $("#weatherResult").innerHTML = "";
    $("#weatherResult").appendChild(renderWeather(data.weather));
    $("#weatherPanel").classList.add("hidden");
    addMessage("user","user",`Weather in ${q}`);
    addMessage("assistant","weather",data.text,{weather:data.weather});
    speak(data.text);
    await loadHistory();
  } catch(e) { $("#weatherResult").textContent = e.message; }
});
$("#weatherInput").addEventListener("keydown",e=>{if(e.key==="Enter")$("#weatherSearch").click()});
$("#mobileHistory").addEventListener("click",()=>$("#history").parentElement.classList.toggle("open"));

checkSession();
