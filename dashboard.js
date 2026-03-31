// ══════════════════════════════════════════════════════════════
// WG Cure Day Hospital — Solar Dashboard Engine
// Nautica-replica, PV-only (no load/grid/export)
// ══════════════════════════════════════════════════════════════

// ── GLOBALS ──────────────────────────────────────────────────
let CONFIG={}, HISTORY={}, PREDICTED={}, finConfig=null, warranties=[], credentials=null;
let dtComments={}, dtCommentsRemote={};
let isLoggedIn=false, charts={};
let ovChartView='today', ovDayOffset=0;

const STORAGE_KEY = 'cureday';
const cacheBust = u => u + (u.includes('?')?'&':'?') + 't=' + Date.now();

// ── CALC DEFAULTS ────────────────────────────────────────────
const CALC_DEFAULTS = {
    env_trees:0.045, env_homes:0.102, env_coal:0.548, env_water:1.4,
    thresh_pv_good:95, thresh_pv_neutral:80,
    deg_baseYear:2024, deg_year1Factor:0.995, deg_annualRate:0.995,
    system_start_year:2024, system_start_month:8,
    default_sc_ratio:1.0
};
let CC = Object.assign({}, CALC_DEFAULTS);
try { const s=localStorage.getItem(STORAGE_KEY+'-calc'); if(s) Object.assign(CC,JSON.parse(s)); } catch(e){}
function saveCalcConfig(){ localStorage.setItem(STORAGE_KEY+'-calc',JSON.stringify(CC)); }
const ENV = { get trees(){return CC.env_trees}, get homes(){return CC.env_homes}, get coal(){return CC.env_coal}, get water(){return CC.env_water} };

// ── UTILITIES ────────────────────────────────────────────────
function fmt(v){ return (v==null||isNaN(v))?'--':Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g,' '); }
function fmtDec(v,d){ return (v==null||isNaN(v))?'--':v.toFixed(d||1).replace(/\B(?=(\d{3})+(?!\d))/g,' '); }
function fmtMoney(v){ return (v==null||isNaN(v))?'R --':'R '+fmtDec(v,2); }
function calcEnv(kwh){ return {trees:Math.round(kwh*ENV.trees),homes:Math.round(kwh*ENV.homes),coal:Math.round(kwh*ENV.coal),water:Math.round(kwh*ENV.water)}; }
function perfClass(pct){ if(pct>=CC.thresh_pv_good) return 'perf-good'; if(pct>=CC.thresh_pv_neutral) return 'perf-neutral'; return 'perf-bad'; }
function statusHtml(actual,predicted){
    if(!predicted||predicted===0) return '';
    const diff=actual-predicted, pct=(diff/predicted*100);
    if(diff>=0) return `<div class="slab-status ahead">▲ ${fmt(Math.abs(diff))} kWh ahead (${Math.abs(pct).toFixed(1)}%)</div>`;
    return `<div class="slab-status behind">▼ ${fmt(Math.abs(diff))} kWh behind (${Math.abs(pct).toFixed(1)}%)</div>`;
}

function setFontScale(s){ document.documentElement.style.setProperty('--font-scale',s); localStorage.setItem(STORAGE_KEY+'-font',s); }
function toggleEnvInfo(){ document.getElementById('envInfoPanel').classList.toggle('open'); document.getElementById('envInfoBtn').classList.toggle('open'); }

// Tariff for a date string
function getTariff(ds){
    if(ds instanceof Date) ds=ds.toISOString().slice(0,10);
    for(const t of CONFIG.tariffs||[]) if(ds>=t.from&&ds<=t.to) return t.rate;
    const tariffs=CONFIG.tariffs||[]; return tariffs.length?tariffs[tariffs.length-1].rate:2.41;
}

// TOU period for a given date+hour
function getTOU(date, hour){
    if(!finConfig) return 'standard';
    const d = date instanceof Date ? date : new Date(date);
    const mo = d.getMonth()+1;
    const wd = d.getDay();
    const season = (finConfig.seasons||{})[String(mo)]||'low_demand';
    const dayType = wd===0?'sunday':wd===6?'saturday':'weekday';
    const schedule = (finConfig.tou_schedule||{})[season]?.[dayType]||[];
    return schedule[hour]||'standard';
}

// Degradation factor
function getDegFactor(dateStr){
    const comm = new Date(CONFIG.commissioning_date||'2024-08-11');
    const d = new Date(dateStr);
    const years = Math.max(0,(d-comm)/(365.25*86400000));
    return Math.pow(CC.deg_annualRate, years);
}

// Get predicted kWh for a month
function getPredMonth(ym){
    const [y,m]=ym.split('-').map(Number);
    const mk=String(m), hourly=PREDICTED.hourly;
    if(!hourly||!hourly[mk]) return 0;
    let total=0;
    for(const d in hourly[mk]) for(const h in hourly[mk][d]) total+=hourly[mk][d][h];
    return total * getDegFactor(ym+'-15');
}

// Get predicted kWh for a specific day
function getPredDay(ym, day){
    const [y,m]=ym.split('-').map(Number);
    const mk=String(m), dk=String(day);
    if(!PREDICTED.hourly?.[mk]?.[dk]) return 0;
    let total=0;
    for(const h in PREDICTED.hourly[mk][dk]) total+=PREDICTED.hourly[mk][dk][h];
    return total * getDegFactor(`${ym}-${String(day).padStart(2,'0')}`);
}

// Get predicted hourly array for a day
function getPredHourly(month, day){
    const mk=String(month), dk=String(day);
    if(!PREDICTED.hourly?.[mk]?.[dk]) return Array(24).fill(0);
    return Array.from({length:24},(_,h)=>PREDICTED.hourly[mk][dk]?.[String(h)]||0);
}

// Days active since commissioning
function getDaysActive(){
    const comm=new Date(CONFIG.commissioning_date||'2024-08-11');
    return Math.floor((new Date()-comm)/(86400000));
}

// All completed months from history
function getAllMonths(){ return (HISTORY.monthly||[]).map(m=>({month:m.month,actual:m.actual_kwh,predicted:m.predicted_kwh})); }

// Current month data
function getThisMonth(){
    const ym=new Date().toISOString().slice(0,7);
    const days=HISTORY.daily?.[ym]||[];
    let actual=days.reduce((s,d)=>s+d.actual_kwh,0);
    const today=HISTORY.today||{};
    if(today.hourly_kw) actual+=today.hourly_kw.reduce((s,v)=>s+(v||0),0);
    const predicted=getPredMonth(ym);
    return {month:ym,actual,predicted,days};
}

// Today data
function getToday(){
    const t=HISTORY.today||{};
    const hourly=t.hourly_kw||[];
    const total=hourly.reduce((s,v)=>s+(v||0),0);
    const now=new Date();
    const predRaw=getPredHourly(now.getMonth()+1,now.getDate());
    const factor=getDegFactor(now.toISOString().slice(0,10));
    return {date:t.date||now.toISOString().slice(0,10),hourly,total,predicted:predRaw.map(v=>v*factor),predTotal:predRaw.reduce((s,v)=>s+v,0)*factor};
}

// Yesterday data
function getYesterday(){
    const ym=new Date().toISOString().slice(0,7);
    const yesterday=new Date(); yesterday.setDate(yesterday.getDate()-1);
    const ys=yesterday.toISOString().slice(0,10);
    const yym=ys.slice(0,7);
    const days=HISTORY.daily?.[yym]||[];
    const found=days.find(d=>d.date===ys);
    return found?found.actual_kwh:0;
}

// Lifetime aggregates
function getLifetime(){
    const months=getAllMonths();
    const tm=getThisMonth();
    const totalActual=months.reduce((s,m)=>s+m.actual,0)+tm.actual;
    const totalPredicted=months.reduce((s,m)=>s+m.predicted,0)+tm.predicted;
    const totalSavings=months.reduce((s,m)=>s+m.actual*getTariff(m.month+'-15'),0)+tm.actual*getTariff(tm.month+'-15');
    return {totalActual,totalPredicted,totalSavings,perf:totalPredicted?(totalActual/totalPredicted*100):0,months};
}

// ── AUTH ──────────────────────────────────────────────────────
async function loadCredentials(){
    try{ const r=await fetch(cacheBust('config/client_credentials.json')); if(r.ok) credentials=await r.json(); }catch(e){}
}
async function hashStr(str){
    const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function checkSession(){
    const s=localStorage.getItem(STORAGE_KEY+'-auth'), t=localStorage.getItem(STORAGE_KEY+'-auth-ts');
    if(s==='ok'&&t&&(Date.now()-parseInt(t))<86400000) return true;
    localStorage.removeItem(STORAGE_KEY+'-auth'); localStorage.removeItem(STORAGE_KEY+'-auth-ts');
    return false;
}
function showLoginModal(){ document.getElementById('loginModal').classList.add('active'); }
function hideLoginModal(){ document.getElementById('loginModal').classList.remove('active'); document.getElementById('loginError').style.display='none'; }
async function handleLogin(e){
    e.preventDefault();
    const u=document.getElementById('loginUser').value, p=document.getElementById('loginPass').value;
    if(credentials){
        const uH=await hashStr(u), pH=await hashStr(p);
        if(uH===credentials.username_hash&&pH===credentials.password_hash){
            localStorage.setItem(STORAGE_KEY+'-auth','ok');
            localStorage.setItem(STORAGE_KEY+'-auth-ts',Date.now().toString());
            isLoggedIn=true; hideLoginModal(); showClientView(); return;
        }
    }
    document.getElementById('loginError').style.display='block';
}
function logout(){
    isLoggedIn=false;
    localStorage.removeItem(STORAGE_KEY+'-auth');
    localStorage.removeItem(STORAGE_KEY+'-auth-ts');
    document.getElementById('editLayoutBtn').style.display='none';
    document.getElementById('calcConfigBtn').style.display='none';
    showPublicView();
}

// ── VIEW SWITCHING ───────────────────────────────────────────
function showPublicView(){
    document.getElementById('publicView').classList.add('active');
    document.getElementById('clientView').classList.remove('active');
    document.getElementById('loginBtn').style.display='';
    document.getElementById('userInfo').style.display='none';
    document.getElementById('loginSection').classList.remove('logged-in');
}
function showClientView(){
    document.getElementById('publicView').classList.remove('active');
    document.getElementById('clientView').classList.add('active');
    document.getElementById('loginBtn').style.display='none';
    document.getElementById('userInfo').style.display='flex';
    document.getElementById('loginSection').classList.add('logged-in');
    document.getElementById('editLayoutBtn').style.display='inline-block';
    document.getElementById('chartDefaultsBtn').style.display='inline-block';
    document.getElementById('calcConfigBtn').style.display='inline-block';
    document.getElementById('infoDaysActive').textContent = getDaysActive();
    document.getElementById('infoLastUpdate').textContent = new Date().toLocaleString('en-ZA',{dateStyle:'medium',timeStyle:'short'});
    renderClientOverview();
}

function switchTab(tab, btn){
    document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-nav button').forEach(b=>b.classList.remove('active'));
    document.getElementById('tab-'+tab).classList.add('active');
    if(btn) btn.classList.add('active');
    // Lazy render tabs
    const renderers = {
        overview: renderClientOverview,
        daily: renderDailyTab,
        monthly: renderMonthlyTab,
        lifetime: renderLifetimeTab,
        financial: renderFinancialTab,
        report: renderReportTab,
        warranty: renderWarrantyTab,
        downtime: renderDowntimeTab
    };
    if(renderers[tab]) renderers[tab]();
}

// ── DATA LOADING ─────────────────────────────────────────────
async function loadData(){
    try{
        const [cfgRes,histRes,predRes,finRes,warRes,credRes,dtRes] = await Promise.all([
            fetch(cacheBust('config.json')), fetch(cacheBust('data/history.json')),
            fetch(cacheBust('data/predicted.json')), fetch(cacheBust('config/financial_config.json')),
            fetch(cacheBust('config/warranties.json')), fetch(cacheBust('config/client_credentials.json')),
            fetch(cacheBust('data/downtime_comments.json')).catch(()=>null)
        ]);
        if(!cfgRes.ok) throw new Error(cfgRes.status);
        CONFIG = await cfgRes.json();
        if(histRes.ok) HISTORY = await histRes.json();
        if(predRes.ok) PREDICTED = await predRes.json();
        if(finRes.ok) finConfig = await finRes.json();
        if(warRes.ok) warranties = await warRes.json();
        if(credRes.ok) credentials = await credRes.json();
        if(dtRes&&dtRes.ok) try{ dtCommentsRemote=await dtRes.json(); dtComments=Object.assign({},dtCommentsRemote); }catch(e){}

        document.getElementById('siteName').textContent = CONFIG.site_name.toUpperCase();
        document.title = CONFIG.site_name + ': Solar Generation';
        if(CONFIG.powered_by) document.getElementById('poweredBy').textContent = CONFIG.powered_by;
        if(CONFIG.powered_by_url) document.getElementById('poweredBy').href = CONFIG.powered_by_url;

        document.getElementById('loadingState').style.display='none';
        renderPublicView();
        if(isLoggedIn) renderClientOverview();
    }catch(err){
        document.getElementById('loadingState').style.display='none';
        document.getElementById('errorState').style.display='block';
        document.getElementById('errorState').textContent='Unable to load solar data. Please try again later. ('+err.message+')';
    }
}

// ── PUBLIC VIEW ──────────────────────────────────────────────
function renderPublicView(){
    const lt=getLifetime(), today=getToday(), yest=getYesterday(), tm=getThisMonth();
    document.getElementById('stat-yesterday').textContent=fmt(yest);
    document.getElementById('stat-today').textContent=fmt(today.total);
    document.getElementById('stat-month').textContent=fmt(tm.actual);
    document.getElementById('stat-lifetime').textContent=fmt(lt.totalActual);

    const periods=[{lbl:'yest',kwh:yest},{lbl:'today',kwh:today.total},{lbl:'month',kwh:tm.actual},{lbl:'life',kwh:lt.totalActual}];
    const rows=[
        {icon:'🌳',name:'Trees Equivalent',fn:e=>fmt(e.trees)},
        {icon:'🏠',name:'Households Powered',fn:e=>fmt(e.homes)},
        {icon:'⛏️',name:'Coal Saved',fn:e=>e.coal>1000?fmtDec(e.coal/1000,1)+' t':fmt(e.coal)+' kg'},
        {icon:'💧',name:'Water Saved',fn:e=>e.water>1000?fmtDec(e.water/1000,1)+' kL':fmt(e.water)+' L'}
    ];
    document.getElementById('envTableBody').innerHTML = rows.map(r=>{
        const cells = periods.map(p=>{ const e=calcEnv(p.kwh); return `<td>${r.fn(e)}</td>`; });
        return `<tr><td><div class="env-metric-cell"><span class="icon">${r.icon}</span><span class="name">${r.name}</span></div></td>${cells.join('')}</tr>`;
    }).join('');
}

// ── OVERVIEW TAB ─────────────────────────────────────────────
function renderClientOverview(){
    const today=getToday(), tm=getThisMonth(), lt=getLifetime();

    // Overview slabs (PV-only: no donut, no flow lines, no coverage)
    const slabs=[
        {label:'Today',actual:today.total,predicted:today.predTotal,click:"switchTab('daily',document.querySelector('[data-tab=daily]'))"},
        {label:'This Month',actual:tm.actual,predicted:tm.predicted,click:"switchTab('monthly',document.querySelector('[data-tab=monthly]'))"},
        {label:'Lifetime',actual:lt.totalActual,predicted:lt.totalPredicted,click:"switchTab('lifetime',document.querySelector('[data-tab=lifetime]'))"}
    ];

    document.getElementById('overviewSlabs').innerHTML = slabs.map(s=>{
        const perf=s.predicted?(s.actual/s.predicted*100):0;
        const savings=s.actual*getTariff(new Date());
        // TOU breakdown for savings
        let touHtml='';
        // We'll show simple total savings for overview
        return `<div class="slab slab-clickable" onclick="${s.click}">
            <div class="slab-label">${s.label}</div>
            <div class="slab-value">${fmt(s.actual)} <span class="slab-unit">kWh</span></div>
            <div class="slab-expected">Expected: <span class="exp-val">${fmt(s.predicted)}</span> <span class="exp-unit">kWh</span></div>
            ${statusHtml(s.actual,s.predicted)}
            <div class="slab-perf"><div class="slab-perf-item"><div class="perf-label">PV Performance</div><div class="perf-value ${perfClass(perf)}">${fmtDec(perf)}%</div></div></div>
            <div class="slab-savings" onclick="event.stopPropagation();this.classList.toggle('open')">
                <div class="sv-row"><span class="sv-label">PV Savings <span class="sv-arrow">▼</span></span><span class="sv-value">${fmtMoney(savings)}</span></div>
            </div>
        </div>`;
    }).join('');

    // Env section in overview
    const envData=[
        {title:'Today',kwh:today.total},
        {title:'This Month',kwh:tm.actual},
        {title:'Lifetime',kwh:lt.totalActual}
    ];
    document.getElementById('ovEnvGrid').innerHTML = envData.map(ed=>{
        const e=calcEnv(ed.kwh);
        return `<div class="env-box"><h3>${ed.title}</h3>
            <div class="env-row"><span class="env-name">Trees Equivalent:</span><span class="env-val">${fmt(e.trees)}</span></div>
            <div class="env-row"><span class="env-name">Households Powered:</span><span class="env-val">${fmt(e.homes)}</span></div>
            <div class="env-row"><span class="env-name">Coal Saved:</span><span class="env-val">${e.coal>1000?fmtDec(e.coal/1000,1)+' t':fmt(e.coal)+' kg'}</span></div>
            <div class="env-row"><span class="env-name">Water Saved:</span><span class="env-val">${e.water>1000?fmtDec(e.water/1000,1)+' kL':fmt(e.water)+' L'}</span></div>
        </div>`;
    }).join('');

    renderOvChart();
}

// ── OVERVIEW CHART ───────────────────────────────────────────
function destroyChart(id){ if(charts[id]){charts[id].destroy();delete charts[id];} }

function setOvChartView(view,btn){
    ovChartView=view;
    document.querySelectorAll('#ovChartSwitch button').forEach(b=>b.classList.remove('active'));
    if(btn)btn.classList.add('active');
    document.getElementById('ovDayNav').style.display=view==='today'?'flex':'none';
    renderOvChart();
}

function shiftOvDay(dir){
    ovDayOffset+=dir;
    if(ovDayOffset>0) ovDayOffset=0;
    renderOvChart();
}
function setOvDay(val){
    const d=new Date(val), today=new Date();
    today.setHours(0,0,0,0); d.setHours(0,0,0,0);
    ovDayOffset=Math.round((d-today)/86400000);
    if(ovDayOffset>0) ovDayOffset=0;
    renderOvChart();
}

function renderOvChart(){
    const canvas=document.getElementById('hourlyChart');
    if(!canvas) return;
    destroyChart('hourly');
    const cm=chartMobile();

    if(ovChartView==='today'){
        // Hourly chart for a specific day
        const targetDate=new Date();
        targetDate.setDate(targetDate.getDate()+ovDayOffset);
        const ds=targetDate.toISOString().slice(0,10);
        const ym=ds.slice(0,7);
        const dayNum=targetDate.getDate();

        document.getElementById('ovDayLabel').textContent = ovDayOffset===0?'Today':ds;
        document.getElementById('ovChartTitle').textContent = 'Hourly Generation — '+(ovDayOffset===0?'Today':ds);

        // Get actual data if it's today
        let actualHourly=Array(24).fill(0);
        if(ovDayOffset===0){
            const t=getToday();
            actualHourly=t.hourly.map(v=>v||0);
        }

        const predRaw=getPredHourly(targetDate.getMonth()+1, dayNum);
        const factor=getDegFactor(ds);
        const predHourly=predRaw.map(v=>v*factor);

        const labels=Array.from({length:24},(_,i)=>String(i).padStart(2,'0')+':00');

        charts.hourly = new Chart(canvas, {
            type:'line',
            data:{labels, datasets:[
                {label:'PV Generation (kW)',data:actualHourly,borderColor:'#4ade80',backgroundColor:'rgba(74,222,128,0.1)',fill:true,tension:0.3,pointRadius:cm.pointRadius,borderWidth:2},
                {label:'Predicted',data:predHourly,borderColor:'#60a5fa',borderDash:[5,5],fill:false,tension:0.3,pointRadius:0,borderWidth:1.5}
            ]},
            options:{responsive:true,maintainAspectRatio:false,
                plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,titleFont:{size:cm.tooltipTitleFont},bodyFont:{size:cm.tooltipBodyFont},padding:cm.tooltipPad}},
                scales:{x:{ticks:{color:'#666',font:{size:cm.tickFont},maxTicksLimit:12},grid:{color:'rgba(255,255,255,0.05)'}},
                    y:{ticks:{color:'#666',font:{size:cm.tickFont}},grid:{color:'rgba(255,255,255,0.05)'},title:{display:cm.showAxisTitles,text:'kW',color:'#666'}}}
            }
        });

    } else if(ovChartView==='month'){
        document.getElementById('ovChartTitle').textContent = 'This Month — Daily Generation';
        const tm=getThisMonth();
        const days=tm.days||[];
        const labels=days.map(d=>d.date.slice(8));
        const actuals=days.map(d=>d.actual_kwh);
        const preds=days.map(d=>getPredDay(tm.month,parseInt(d.date.slice(8))));

        charts.hourly = new Chart(canvas, {
            type:'bar',
            data:{labels,datasets:[
                {label:'Actual (kWh)',data:actuals,backgroundColor:'rgba(74,222,128,0.6)',borderColor:'#4ade80',borderWidth:cm.barBorderWidth,borderRadius:4},
                {label:'Predicted',data:preds,backgroundColor:'rgba(96,165,250,0.3)',borderColor:'#60a5fa',borderWidth:cm.barBorderWidth,borderRadius:4}
            ]},
            options:{responsive:true,maintainAspectRatio:false,
                plugins:{legend:{display:false},tooltip:{mode:'index'}},
                scales:{x:{ticks:{color:'#666',font:{size:cm.tickFont}},grid:{color:'rgba(255,255,255,0.05)'}},
                    y:{ticks:{color:'#666',font:{size:cm.tickFont}},grid:{color:'rgba(255,255,255,0.05)'},title:{display:cm.showAxisTitles,text:'kWh',color:'#666'}}}
            }
        });

    } else {
        document.getElementById('ovChartTitle').textContent = 'Lifetime — Monthly Generation';
        const months=getAllMonths();
        const tm=getThisMonth();
        const allM=[...months,{month:tm.month,actual:tm.actual,predicted:tm.predicted}];
        const labels=allM.map(m=>m.month);
        const actuals=allM.map(m=>m.actual);
        const preds=allM.map(m=>m.predicted);
        // Cumulative performance line
        let cumAct=0,cumPred=0;
        const cumPerf=allM.map(m=>{cumAct+=m.actual;cumPred+=m.predicted;return cumPred?cumAct/cumPred*100:0;});

        charts.hourly = new Chart(canvas, {
            type:'bar',
            data:{labels,datasets:[
                {label:'Actual (kWh)',data:actuals,backgroundColor:'rgba(74,222,128,0.6)',borderRadius:4,yAxisID:'y'},
                {label:'Predicted (kWh)',data:preds,backgroundColor:'rgba(96,165,250,0.3)',borderRadius:4,yAxisID:'y'},
                {label:'Cumulative Perf %',data:cumPerf,type:'line',borderColor:'#FFD700',backgroundColor:'transparent',pointRadius:2,yAxisID:'y1',tension:0.3,borderWidth:2}
            ]},
            options:{responsive:true,maintainAspectRatio:false,
                plugins:{legend:{display:false}},
                scales:{x:{ticks:{color:'#666',font:{size:cm.tickFont},maxRotation:45},grid:{color:'rgba(255,255,255,0.05)'}},
                    y:{ticks:{color:'#666'},grid:{color:'rgba(255,255,255,0.05)'},title:{display:cm.showAxisTitles,text:'kWh',color:'#666'}},
                    y1:{position:'right',ticks:{color:'#FFD700',callback:v=>v.toFixed(0)+'%'},grid:{display:false},min:0,max:150}}
            }
        });
    }
}

// ── PV DISTRIBUTION CHART ────────────────────────────────────
function setPvdPeriod(period,btn){
    document.querySelectorAll('#pvdPeriodBtns button').forEach(b=>b.classList.remove('active'));
    if(btn) btn.classList.add('active');
    renderPvDistChart(period);
}

function renderPvDistChart(period){
    if(!period) period='month';
    destroyChart('pvDist');
    const canvas=document.getElementById('pvDistChart');
    if(!canvas) return;

    // Collect hourly data grouped by hour-of-day
    const hourBuckets=Array.from({length:24},()=>[]);
    const now=new Date();
    const ym=now.toISOString().slice(0,7);
    const year=now.getFullYear();

    function addDayData(dayArr){
        // dayArr is array of 24 values
        dayArr.forEach((v,h)=>{ if(v&&v>0) hourBuckets[h].push(v); });
    }

    // We use predicted data to build the distribution (since we have 365 days of it)
    for(const mk in PREDICTED.hourly||{}){
        const m=parseInt(mk);
        if(period==='month' && m!==now.getMonth()+1) continue;
        if(period==='year') {} // include all
        for(const dk in PREDICTED.hourly[mk]){
            const arr=Array.from({length:24},(_,h)=>PREDICTED.hourly[mk][dk]?.[String(h)]||0);
            addDayData(arr);
        }
    }

    const labels=Array.from({length:24},(_,i)=>String(i).padStart(2,'0')+':00');
    const stats=hourBuckets.map(bucket=>{
        if(!bucket.length) return {min:0,p10:0,p25:0,median:0,p75:0,p90:0,max:0};
        bucket.sort((a,b)=>a-b);
        const pct=p=>bucket[Math.floor(p/100*(bucket.length-1))];
        return {min:bucket[0],p10:pct(10),p25:pct(25),median:pct(50),p75:pct(75),p90:pct(90),max:bucket[bucket.length-1]};
    });

    charts.pvDist = new Chart(canvas, {
        type:'line',
        data:{labels,datasets:[
            {label:'Max',data:stats.map(s=>s.max),borderColor:'#a78bfa',borderWidth:1,pointRadius:0,fill:false},
            {label:'P90',data:stats.map(s=>s.p90),borderColor:'transparent',backgroundColor:'rgba(34,197,94,0.18)',fill:'+1',pointRadius:0},
            {label:'P75',data:stats.map(s=>s.p75),borderColor:'transparent',backgroundColor:'rgba(34,197,94,0.45)',fill:'+1',pointRadius:0},
            {label:'Median',data:stats.map(s=>s.median),borderColor:'#16a34a',borderWidth:2,pointRadius:0,fill:false},
            {label:'P25',data:stats.map(s=>s.p25),borderColor:'transparent',backgroundColor:'rgba(34,197,94,0.45)',fill:'+1',pointRadius:0},
            {label:'P10',data:stats.map(s=>s.p10),borderColor:'transparent',backgroundColor:'rgba(34,197,94,0.18)',fill:false,pointRadius:0},
            {label:'Min',data:stats.map(s=>s.min),borderColor:'#facc15',borderWidth:1,pointRadius:0,fill:false}
        ]},
        options:{responsive:true,maintainAspectRatio:false,
            plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false}},
            scales:{x:{ticks:{color:'#666',maxTicksLimit:12},grid:{color:'rgba(255,255,255,0.05)'}},
                y:{ticks:{color:'#666'},grid:{color:'rgba(255,255,255,0.05)'},title:{display:true,text:'kW',color:'#666'}}}
        }
    });
}

// ── DAILY TAB ────────────────────────────────────────────────
let dailyDate=new Date().toISOString().slice(0,10);
function renderDailyTab(){
    const el=document.getElementById('tab-daily');
    if(!el.querySelector('.daily-header')){
        el.innerHTML=`
            <div class="daily-header">
                <div class="date-picker">
                    <button class="dp-arrow" onclick="shiftDailyDate(-1)">◄</button>
                    <input type="date" id="dailyDatePicker" value="${dailyDate}" onchange="dailyDate=this.value;renderDailyTab()">
                    <button class="dp-arrow" onclick="shiftDailyDate(1)">►</button>
                    <button class="btn-this-month" style="margin-left:8px;background:rgba(255,215,0,0.15);border:1px solid var(--gold);border-radius:8px;color:var(--gold);padding:8px 14px;font-size:var(--font-xs);cursor:pointer;font-family:inherit;" onclick="dailyDate=new Date().toISOString().slice(0,10);document.getElementById('dailyDatePicker').value=dailyDate;renderDailyTab()">Today</button>
                </div>
                <div class="daily-status" id="dailyStatus"></div>
            </div>
            <div class="daily-grid" id="dailySlabs"></div>
            <div class="daily-savings-table"><h3>Savings Breakdown</h3><div class="env-table-wrap"><table class="env-table"><thead><tr><th>TOU Period</th><th>Generation</th><th>PV Savings</th></tr></thead><tbody id="dailySavingsBody"></tbody></table></div></div>
            <div class="chart-container"><h3>Hourly Generation Pattern</h3><div class="chart-wrap"><canvas id="dailyHourlyChart"></canvas></div></div>`;
    }

    const ym=dailyDate.slice(0,7);
    const dayNum=parseInt(dailyDate.slice(8));
    const d=new Date(dailyDate);

    // Check if we have daily data
    const days=HISTORY.daily?.[ym]||[];
    const dayData=days.find(dd=>dd.date===dailyDate);
    const actual=dayData?dayData.actual_kwh:0;
    const predicted=getPredDay(ym,dayNum);
    const perf=predicted?(actual/predicted*100):0;
    const savings=actual*getTariff(dailyDate);

    document.getElementById('dailySlabs').innerHTML=`
        <div class="slab"><div class="slab-label">PV Generation</div><div class="slab-value">${fmtDec(actual)} <span class="slab-unit">kWh</span></div>
            <div class="slab-expected">Expected: <span class="exp-val">${fmtDec(predicted)}</span> <span class="exp-unit">kWh</span></div>
            ${statusHtml(actual,predicted)}
            <div class="slab-perf"><div class="slab-perf-item"><div class="perf-label">PV Performance</div><div class="perf-value ${perfClass(perf)}">${fmtDec(perf)}%</div></div></div>
        </div>
        <div class="slab"><div class="slab-label">PV Savings</div><div class="slab-value" style="color:var(--green)">${fmtMoney(savings)}</div>
            <div class="slab-expected">Tariff: <span class="exp-val">${CONFIG.currency}${getTariff(dailyDate).toFixed(2)}</span> <span class="exp-unit">/kWh</span></div>
        </div>
        <div class="slab"><div class="slab-label">Peak Power</div><div class="slab-value">${fmtDec(actual>0?actual/8:0)} <span class="slab-unit">kW avg</span></div></div>`;

    // TOU savings breakdown
    const touTotals={peak:0,standard:0,off_peak:0};
    const predH=getPredHourly(d.getMonth()+1,dayNum);
    const factor=getDegFactor(dailyDate);
    for(let h=0;h<24;h++){
        const period=getTOU(d,h);
        const val=predH[h]*factor*(actual/Math.max(predicted,1)); // proportion actual across hours
        touTotals[period]+=val;
    }
    const tariff=getTariff(dailyDate);
    document.getElementById('dailySavingsBody').innerHTML=['peak','standard','off_peak'].map(p=>{
        const gen=touTotals[p]||0;
        return `<tr><td class="period-${p.replace('_','-')}">${p.replace('_','-').replace(/\b\w/g,l=>l.toUpperCase())}</td><td>${fmtDec(gen)} kWh</td><td style="color:var(--green)">${fmtMoney(gen*tariff)}</td></tr>`;
    }).join('')+`<tr style="font-weight:700;border-top:2px solid var(--gold)"><td>Total</td><td>${fmtDec(actual)} kWh</td><td style="color:var(--green)">${fmtMoney(savings)}</td></tr>`;

    // Hourly chart
    destroyChart('dailyHourly');
    const canvas=document.getElementById('dailyHourlyChart');
    if(!canvas) return;
    const labels=Array.from({length:24},(_,i)=>String(i).padStart(2,'0')+':00');
    const predHourly=predH.map(v=>v*factor);
    // If we have today's hourly data
    let actualHourly=Array(24).fill(null);
    if(dailyDate===new Date().toISOString().slice(0,10)){
        const t=getToday();
        actualHourly=t.hourly;
    }

    charts.dailyHourly = new Chart(canvas, {
        type:'line',
        data:{labels,datasets:[
            {label:'Actual (kW)',data:actualHourly.map(v=>v||0),borderColor:'#4ade80',backgroundColor:'rgba(74,222,128,0.1)',fill:true,tension:0.3,pointRadius:0,borderWidth:2},
            {label:'Predicted',data:predHourly,borderColor:'#60a5fa',borderDash:[5,5],fill:false,tension:0.3,pointRadius:0,borderWidth:1.5}
        ]},
        options:{responsive:true,maintainAspectRatio:false,
            plugins:{legend:{labels:{color:'#aaa'}},tooltip:{mode:'index',intersect:false}},
            scales:{x:{ticks:{color:'#666',maxTicksLimit:12},grid:{color:'rgba(255,255,255,0.05)'}},
                y:{ticks:{color:'#666'},grid:{color:'rgba(255,255,255,0.05)'},title:{display:true,text:'kW',color:'#666'}}}
        }
    });
}
function shiftDailyDate(dir){
    const d=new Date(dailyDate);
    d.setDate(d.getDate()+dir);
    dailyDate=d.toISOString().slice(0,10);
    document.getElementById('dailyDatePicker').value=dailyDate;
    renderDailyTab();
}

// ── MONTHLY TAB ──────────────────────────────────────────────
let selectedMonth='';
function renderMonthlyTab(){
    const el=document.getElementById('tab-monthly');
    const months=getAllMonths();
    const tm=getThisMonth();
    const allM=[...months,{month:tm.month,actual:tm.actual,predicted:tm.predicted}];
    if(!selectedMonth) selectedMonth=tm.month;

    el.innerHTML=`
        <div class="month-selector">
            <select id="monthlySelect" onchange="selectedMonth=this.value;renderMonthlyTab()">
                ${allM.map(m=>`<option value="${m.month}" ${m.month===selectedMonth?'selected':''}>${m.month}</option>`).join('')}
            </select>
            <button class="btn-this-month" onclick="selectedMonth='${tm.month}';renderMonthlyTab()">This Month</button>
        </div>
        <div class="monthly-grid" id="monthlySlabs"></div>
        <div class="daily-savings-table"><h3>Savings Breakdown</h3><div class="env-table-wrap"><table class="env-table"><thead><tr><th>TOU Period</th><th>Generation</th><th>PV Savings</th></tr></thead><tbody id="monthlySavingsBody"></tbody></table></div></div>
        <div class="chart-container"><h3>Daily Generation for ${selectedMonth}</h3><div class="chart-wrap"><canvas id="monthlyDailyChart"></canvas></div></div>`;

    const sel=allM.find(m=>m.month===selectedMonth)||allM[allM.length-1];
    const perf=sel.predicted?(sel.actual/sel.predicted*100):0;
    const savings=sel.actual*getTariff(sel.month+'-15');

    document.getElementById('monthlySlabs').innerHTML=`
        <div class="slab"><div class="slab-label">PV Generation</div><div class="slab-value">${fmt(sel.actual)} <span class="slab-unit">kWh</span></div>
            <div class="slab-expected">Expected: <span class="exp-val">${fmt(sel.predicted)}</span> <span class="exp-unit">kWh</span></div>
            ${statusHtml(sel.actual,sel.predicted)}
            <div class="slab-perf"><div class="slab-perf-item"><div class="perf-label">PV Performance</div><div class="perf-value ${perfClass(perf)}">${fmtDec(perf)}%</div></div></div>
        </div>
        <div class="slab"><div class="slab-label">PV Savings</div><div class="slab-value" style="color:var(--green)">${fmtMoney(savings)}</div></div>
        <div class="slab"><div class="slab-label">Target Progress</div><div class="slab-value ${perfClass(perf)}">${fmtDec(perf)}%</div>
            <div class="slab-expected">Actual: <span class="exp-val">${fmt(sel.actual)}</span> <span class="exp-unit">kWh</span></div>
            <div class="slab-perf"><div class="slab-perf-item"><div class="perf-label">Target</div><div class="perf-value">${fmt(sel.predicted)} kWh</div></div></div>
        </div>`;

    // TOU breakdown
    const tariff=getTariff(sel.month+'-15');
    document.getElementById('monthlySavingsBody').innerHTML=`
        <tr><td>All Periods</td><td>${fmt(sel.actual)} kWh</td><td style="color:var(--green)">${fmtMoney(savings)}</td></tr>`;

    // Daily chart
    destroyChart('monthlyDaily');
    const days=HISTORY.daily?.[selectedMonth]||[];
    if(days.length){
        const canvas=document.getElementById('monthlyDailyChart');
        charts.monthlyDaily = new Chart(canvas,{
            type:'bar',
            data:{labels:days.map(d=>d.date.slice(8)),datasets:[
                {label:'Actual',data:days.map(d=>d.actual_kwh),backgroundColor:'rgba(74,222,128,0.6)',borderRadius:4},
                {label:'Predicted',data:days.map(d=>getPredDay(selectedMonth,parseInt(d.date.slice(8)))),backgroundColor:'rgba(96,165,250,0.3)',borderRadius:4}
            ]},
            options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#aaa'}}},
                scales:{x:{ticks:{color:'#666'},grid:{color:'rgba(255,255,255,0.05)'}},y:{ticks:{color:'#666'},grid:{color:'rgba(255,255,255,0.05)'},title:{display:true,text:'kWh',color:'#666'}}}}
        });
    }
}

// ── LIFETIME TAB ─────────────────────────────────────────────
let ltRange=0;
function renderLifetimeTab(){
    const lt=getLifetime(), env=calcEnv(lt.totalActual), tm=getThisMonth();
    const el=document.getElementById('tab-lifetime');

    el.innerHTML=`
        <div style="display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap;">
            <span style="color:#94a3b8;font-size:var(--font-xs);font-weight:600;padding:8px 0;">Range:</span>
            <button class="lt-range-btn" onclick="ltRange=3;renderLifetimeTab()">3M</button>
            <button class="lt-range-btn" onclick="ltRange=6;renderLifetimeTab()">6M</button>
            <button class="lt-range-btn" onclick="ltRange=12;renderLifetimeTab()">12M</button>
            <button class="lt-range-btn ${ltRange===0?'active':''}" onclick="ltRange=0;renderLifetimeTab()">All</button>
        </div>
        <div class="monthly-grid" id="lifetimeGrid">
            <div class="slab"><div class="slab-label">PV Generation</div><div class="slab-value">${fmt(lt.totalActual)} <span class="slab-unit">kWh</span></div>
                <div class="slab-expected">Expected: <span class="exp-val">${fmt(lt.totalPredicted)}</span> <span class="exp-unit">kWh</span></div>
                ${statusHtml(lt.totalActual,lt.totalPredicted)}
                <div class="slab-perf"><div class="slab-perf-item"><div class="perf-label">PV Performance</div><div class="perf-value ${perfClass(lt.perf)}">${fmtDec(lt.perf)}%</div></div></div>
            </div>
            <div class="slab"><div class="slab-label">Lifetime Savings</div><div class="slab-value" style="color:var(--green)">${fmtMoney(lt.totalSavings)}</div></div>
            <div class="slab"><div class="slab-label">Lifetime Performance</div><div class="slab-value ${perfClass(lt.perf)}">${fmtDec(lt.perf)}%</div>
                <div class="slab-perf"><div class="slab-perf-item"><div class="perf-label">Target</div><div class="perf-value">${fmt(lt.totalPredicted)} kWh</div></div></div>
            </div>
        </div>
        <div class="env-section-title">Environmental Impact</div>
        <div class="env-grid-4">
            <div class="env-box" style="text-align:center;"><h3>🌳 Trees</h3><div class="slab-value" style="text-align:center;font-size:clamp(1.2em,2.5vw,1.8em);">${fmt(env.trees)}</div></div>
            <div class="env-box" style="text-align:center;"><h3>🏠 Households</h3><div class="slab-value" style="text-align:center;font-size:clamp(1.2em,2.5vw,1.8em);">${fmt(env.homes)}</div></div>
            <div class="env-box" style="text-align:center;"><h3>⛏️ Coal Saved</h3><div class="slab-value" style="text-align:center;font-size:clamp(1.2em,2.5vw,1.8em);">${env.coal>1000?fmtDec(env.coal/1000,1)+' t':fmt(env.coal)+' kg'}</div></div>
            <div class="env-box" style="text-align:center;"><h3>💧 Water Saved</h3><div class="slab-value" style="text-align:center;font-size:clamp(1.2em,2.5vw,1.8em);">${env.water>1000?fmtDec(env.water/1000,1)+' kL':fmt(env.water)+' L'}</div></div>
        </div>
        <div class="chart-container"><h3>Monthly Generation Breakdown</h3><div class="chart-wrap"><canvas id="lifetimeGenChart"></canvas></div></div>
        <div class="chart-container"><h3>Actual vs Predicted Savings</h3><div class="chart-wrap"><canvas id="lifetimeSavChart"></canvas></div></div>`;

    // Highlight active range button
    el.querySelectorAll('.lt-range-btn').forEach(b=>{
        const val=b.textContent==='All'?0:parseInt(b.textContent);
        if(val===ltRange) b.classList.add('active'); else b.classList.remove('active');
    });

    let months=[...lt.months,{month:tm.month,actual:tm.actual,predicted:tm.predicted}];
    if(ltRange>0) months=months.slice(-ltRange);

    // Gen chart
    destroyChart('lifetimeGen');
    let cumAct=0,cumPred=0;
    const cumPerf=months.map(m=>{cumAct+=m.actual;cumPred+=m.predicted;return cumPred?cumAct/cumPred*100:0;});
    charts.lifetimeGen = new Chart(document.getElementById('lifetimeGenChart'),{
        type:'bar',
        data:{labels:months.map(m=>m.month),datasets:[
            {label:'Actual',data:months.map(m=>m.actual),backgroundColor:'rgba(74,222,128,0.7)',borderRadius:4,yAxisID:'y'},
            {label:'Predicted',data:months.map(m=>m.predicted),backgroundColor:'rgba(96,165,250,0.3)',borderRadius:4,yAxisID:'y'},
            {label:'Cumulative %',data:cumPerf,type:'line',borderColor:'#FFD700',pointRadius:2,yAxisID:'y1',tension:0.3,borderWidth:2}
        ]},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#aaa'}}},
            scales:{x:{ticks:{color:'#666',maxRotation:45},grid:{color:'rgba(255,255,255,0.05)'}},
                y:{ticks:{color:'#666'},grid:{color:'rgba(255,255,255,0.05)'}},
                y1:{position:'right',ticks:{color:'#FFD700',callback:v=>v.toFixed(0)+'%'},grid:{display:false},min:0,max:150}}}
    });

    // Savings chart
    destroyChart('lifetimeSav');
    charts.lifetimeSav = new Chart(document.getElementById('lifetimeSavChart'),{
        type:'bar',
        data:{labels:months.map(m=>m.month),datasets:[
            {label:'Actual Savings',data:months.map(m=>m.actual*getTariff(m.month+'-15')),backgroundColor:'rgba(74,222,128,0.7)',borderRadius:4},
            {label:'Predicted Savings',data:months.map(m=>m.predicted*getTariff(m.month+'-15')),backgroundColor:'rgba(96,165,250,0.5)',borderRadius:4}
        ]},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#aaa'}},tooltip:{callbacks:{label:ctx=>'R '+ctx.parsed.y.toFixed(2)}}},
            scales:{x:{ticks:{color:'#666',maxRotation:45},grid:{color:'rgba(255,255,255,0.05)'}},
                y:{ticks:{color:'#666',callback:v=>'R'+v.toLocaleString()},grid:{color:'rgba(255,255,255,0.05)'}}}}
    });
}

// ── FINANCIAL TAB ────────────────────────────────────────────
let finRange=0;
function renderFinancialTab(){
    const lt=getLifetime(), tm=getThisMonth();
    const allM=[...lt.months,{month:tm.month,actual:tm.actual,predicted:tm.predicted}];
    const el=document.getElementById('tab-financial');

    const totalSavings=lt.totalSavings;
    const yearStart=new Date().getFullYear();
    const yearData=allM.filter(m=>m.month.startsWith(String(yearStart)));
    const yearSavings=yearData.reduce((s,m)=>s+m.actual*getTariff(m.month+'-15'),0);

    el.innerHTML=`
        <div class="slab" style="text-align:center;margin-bottom:20px;">
            <div class="slab-label">Total Lifetime Savings</div>
            <div class="slab-value" style="font-size:2.5em;"><span style="color:#fff;">R </span><span style="color:var(--green)">${fmtDec(totalSavings,2)}</span></div>
        </div>
        <div class="fin-tou-grid">
            <div class="slab" style="text-align:center;"><div class="slab-label">This Year</div><div class="slab-value" style="color:var(--green)">${fmtMoney(yearSavings)}</div></div>
            <div class="slab" style="text-align:center;"><div class="slab-label">This Month</div><div class="slab-value" style="color:var(--green)">${fmtMoney(tm.actual*getTariff(tm.month+'-15'))}</div></div>
            <div class="slab" style="text-align:center;"><div class="slab-label">Current Tariff</div><div class="slab-value">${CONFIG.currency}${getTariff(new Date()).toFixed(2)} <span class="slab-unit">/kWh</span></div></div>
        </div>
        <div class="chart-container">
            <h3>Monthly Savings</h3>
            <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">
                <button class="lt-range-btn" onclick="finRange=6;renderFinancialTab()">6M</button>
                <button class="lt-range-btn" onclick="finRange=12;renderFinancialTab()">12M</button>
                <button class="lt-range-btn ${finRange===0?'active':''}" onclick="finRange=0;renderFinancialTab()">All</button>
            </div>
            <div class="chart-wrap"><canvas id="finSavChart"></canvas></div>
        </div>`;

    // Highlight active
    el.querySelectorAll('.lt-range-btn').forEach(b=>{
        const val=b.textContent==='All'?0:parseInt(b.textContent);
        if(val===finRange) b.classList.add('active'); else b.classList.remove('active');
    });

    let months=[...allM];
    if(finRange>0) months=months.slice(-finRange);

    destroyChart('finSav');
    let cumSav=0;
    const cumData=months.map(m=>{cumSav+=m.actual*getTariff(m.month+'-15');return cumSav;});

    charts.finSav = new Chart(document.getElementById('finSavChart'),{
        type:'bar',
        data:{labels:months.map(m=>m.month),datasets:[
            {label:'Monthly Savings',data:months.map(m=>m.actual*getTariff(m.month+'-15')),backgroundColor:months.map(m=>{const r=getTariff(m.month+'-15');return r>=2.4?'rgba(74,222,128,0.7)':r>=2?'rgba(255,215,0,0.7)':'rgba(96,165,250,0.7)';}),borderRadius:4,yAxisID:'y'},
            {label:'Cumulative',data:cumData,type:'line',borderColor:'#FFD700',pointRadius:2,yAxisID:'y1',tension:0.3,borderWidth:2}
        ]},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#aaa'}},tooltip:{callbacks:{label:ctx=>'R '+ctx.parsed.y.toFixed(2)}}},
            scales:{x:{ticks:{color:'#666',maxRotation:45},grid:{color:'rgba(255,255,255,0.05)'}},
                y:{ticks:{color:'#666',callback:v=>'R'+v.toLocaleString()},grid:{color:'rgba(255,255,255,0.05)'}},
                y1:{position:'right',ticks:{color:'#FFD700',callback:v=>'R'+Math.round(v).toLocaleString()},grid:{display:false}}}}
    });
}

// ── REPORT TAB ───────────────────────────────────────────────
function renderReportTab(){
    const el=document.getElementById('tab-report');
    const tm=getThisMonth();
    const allM=getAllMonths();
    if(el.querySelector('.overview-title')) return; // already rendered

    el.innerHTML=`
        <div class="overview-title">Report Generator</div>
        <div class="report-controls">
            <div class="report-row">
                <label>From</label><input type="month" id="rptFrom" value="2024-08">
                <label>To</label><input type="month" id="rptTo" value="${new Date().toISOString().slice(0,7)}">
            </div>
            <div class="report-row">
                <button class="report-gen-btn" onclick="generateReport()">Generate Report</button>
                <button class="report-export-btn" id="rptExportBtn" style="display:none;" onclick="exportReportCSV()">⬇ Export CSV</button>
            </div>
        </div>
        <div id="reportOutput"></div>`;
}

function generateReport(){
    const from=document.getElementById('rptFrom').value;
    const to=document.getElementById('rptTo').value;
    if(!from||!to) return;

    const months=getAllMonths().filter(m=>m.month>=from&&m.month<=to);
    const tm=getThisMonth();
    if(tm.month>=from&&tm.month<=to) months.push({month:tm.month,actual:tm.actual,predicted:tm.predicted});
    if(!months.length){document.getElementById('reportOutput').innerHTML='<div class="slab" style="text-align:center;color:var(--text-dim);">No data</div>';return;}

    const totalA=months.reduce((s,m)=>s+m.actual,0);
    const totalP=months.reduce((s,m)=>s+m.predicted,0);
    const totalS=months.reduce((s,m)=>s+m.actual*getTariff(m.month+'-15'),0);
    const avgPerf=totalP?(totalA/totalP*100):0;

    let html=`<div class="report-summary">
        <div class="slab"><div class="slab-label">Total Generation</div><div class="slab-value">${fmt(totalA)} kWh</div></div>
        <div class="slab"><div class="slab-label">Total Predicted</div><div class="slab-value">${fmt(totalP)} kWh</div></div>
        <div class="slab"><div class="slab-label">Avg Performance</div><div class="slab-value ${perfClass(avgPerf)}">${fmtDec(avgPerf)}%</div></div>
        <div class="slab"><div class="slab-label">Total Savings</div><div class="slab-value" style="color:var(--green)">${fmtMoney(totalS)}</div></div>
    </div><div class="report-table-wrap" style="margin-top:20px;"><table class="report-table">
        <thead><tr><th style="text-align:left">Month</th><th>Actual</th><th>Predicted</th><th>Perf %</th><th>Tariff</th><th>Savings</th></tr></thead><tbody>`;

    months.forEach(m=>{
        const perf=m.predicted?(m.actual/m.predicted*100):0;
        const tariff=getTariff(m.month+'-15');
        const sav=m.actual*tariff;
        html+=`<tr><td>${m.month}</td><td>${fmt(m.actual)}</td><td>${fmt(m.predicted)}</td><td class="${perfClass(perf)}">${fmtDec(perf)}%</td><td>R${tariff.toFixed(2)}</td><td style="color:var(--green)">${fmtMoney(sav)}</td></tr>`;
    });

    html+=`<tr style="font-weight:700;border-top:2px solid var(--gold)"><td>TOTAL</td><td>${fmt(totalA)}</td><td>${fmt(totalP)}</td><td class="${perfClass(avgPerf)}">${fmtDec(avgPerf)}%</td><td></td><td style="color:var(--green)">${fmtMoney(totalS)}</td></tr></tbody></table></div>`;
    document.getElementById('reportOutput').innerHTML=html;
    document.getElementById('rptExportBtn').style.display='inline-block';
}

function exportReportCSV(){
    const rows=[['Month','Actual_kWh','Predicted_kWh','Performance_%','Tariff_R','Savings_R']];
    const from=document.getElementById('rptFrom').value, to=document.getElementById('rptTo').value;
    const months=getAllMonths().filter(m=>m.month>=from&&m.month<=to);
    const tm=getThisMonth();
    if(tm.month>=from&&tm.month<=to) months.push({month:tm.month,actual:tm.actual,predicted:tm.predicted});
    months.forEach(m=>{
        const perf=m.predicted?(m.actual/m.predicted*100):0;
        const tariff=getTariff(m.month+'-15');
        rows.push([m.month,m.actual.toFixed(1),m.predicted.toFixed(1),perf.toFixed(1),tariff.toFixed(2),(m.actual*tariff).toFixed(2)]);
    });
    const csv=rows.map(r=>r.join(',')).join('\n');
    const blob=new Blob([csv],{type:'text/csv'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=`CureDay_Report_${from}_${to}.csv`;a.click();
    URL.revokeObjectURL(url);
}

// ── WARRANTY TAB ─────────────────────────────────────────────
function renderWarrantyTab(){
    const el=document.getElementById('tab-warranty');
    const now=new Date();
    el.innerHTML=`<div class="overview-title">System Warranties</div><div class="warranty-grid" id="warrantyDonuts"></div>
        <div class="daily-savings-table" style="margin-top:30px;"><h3>Warranty Details</h3><div class="env-table-wrap"><table class="env-table">
            <thead><tr><th>Item</th><th>Start Date</th><th>Duration</th><th>Expiry Date</th><th>Remaining</th><th>Status</th></tr></thead>
            <tbody id="warrantyTableBody"></tbody></table></div></div>`;

    let donutsHtml='', tableHtml='';
    warranties.forEach((w,i)=>{
        const start=new Date(w.start);
        const expiry=new Date(start); expiry.setFullYear(expiry.getFullYear()+w.years);
        const totalDays=(expiry-start)/86400000;
        const elapsed=(now-start)/86400000;
        const remaining=Math.max(0,(expiry-now)/86400000);
        const pct=Math.min(100,elapsed/totalDays*100);
        const yearsRemaining=(remaining/365.25).toFixed(1);
        const status=remaining<=0?'expired':remaining<365?'expiring':'active';
        const statusLabel=status==='expired'?'Expired':status==='expiring'?'Expiring Soon':'Active';
        const statusColor=status==='expired'?'#ef4444':status==='expiring'?'#f59e0b':'#4ade80';

        donutsHtml+=`<div class="warranty-card">
            <div class="warranty-card-title">${w.item}</div>
            <div class="warranty-donut-wrap"><canvas id="wDonut${i}"></canvas></div>
            <div class="warranty-stats">
                <div class="warranty-stat"><div class="warranty-stat-val warranty-status-${status}">${yearsRemaining}</div><div class="warranty-stat-label">Years Left</div></div>
                <div class="warranty-stat"><div class="warranty-stat-val">${w.years}</div><div class="warranty-stat-label">Total Years</div></div>
            </div>
        </div>`;

        tableHtml+=`<tr>
            <td>${w.item}</td>
            <td>${start.toLocaleDateString('en-ZA',{day:'numeric',month:'short',year:'numeric'})}</td>
            <td>${w.years} years</td>
            <td>${expiry.toLocaleDateString('en-ZA',{day:'numeric',month:'short',year:'numeric'})}</td>
            <td style="color:${statusColor}">${yearsRemaining} years</td>
            <td style="color:${statusColor}">${statusLabel}</td>
        </tr>`;
    });

    document.getElementById('warrantyDonuts').innerHTML=donutsHtml;
    document.getElementById('warrantyTableBody').innerHTML=tableHtml;

    // Render donut charts
    warranties.forEach((w,i)=>{
        const start=new Date(w.start);
        const expiry=new Date(start); expiry.setFullYear(expiry.getFullYear()+w.years);
        const totalDays=(expiry-start)/86400000;
        const elapsed=Math.min(totalDays,(now-start)/86400000);
        const pct=elapsed/totalDays*100;
        const remaining=100-pct;
        const color=remaining<=0?'#ef4444':remaining<(100/w.years)?'#f59e0b':'#4ade80';

        destroyChart('wDonut'+i);
        charts['wDonut'+i]=new Chart(document.getElementById('wDonut'+i),{
            type:'doughnut',
            data:{datasets:[{data:[pct,Math.max(0,remaining)],backgroundColor:[color,'rgba(255,255,255,0.06)'],borderWidth:0}]},
            options:{responsive:true,maintainAspectRatio:true,cutout:'75%',
                plugins:{legend:{display:false},tooltip:{enabled:false}}}
        });
    });
}

// ── DOWNTIME TAB ─────────────────────────────────────────────
let dtRange='today';
function renderDowntimeTab(){
    const el=document.getElementById('tab-downtime');
    el.innerHTML=`
        <div class="overview-title">Downtime Analysis</div>
        <div class="month-selector" style="margin-bottom:20px;">
            <button class="lt-range-btn active" onclick="dtRange='today';renderDowntimeTab()">Today</button>
            <button class="lt-range-btn" onclick="dtRange='month';renderDowntimeTab()">This Month</button>
            <button class="lt-range-btn" onclick="dtRange='lifetime';renderDowntimeTab()">Lifetime</button>
        </div>
        <div class="dt-summary-grid">
            <div class="dt-card"><div class="dt-card-label">PV Downtime</div><div class="dt-card-value" id="dtPvHours">--</div><div class="dt-card-sub">hours</div></div>
            <div class="dt-card"><div class="dt-card-label">Lost PV Generation</div><div class="dt-card-value" id="dtLostKwh">--</div><div class="dt-card-sub">kWh</div></div>
            <div class="dt-card"><div class="dt-card-label">Lost Savings</div><div class="dt-card-value" id="dtLostRand">--</div><div class="dt-card-sub">ZAR</div></div>
        </div>
        <div class="chart-container" style="margin-top:20px;">
            <h3 id="dtHeatmapTitle">Hourly Status — Today</h3>
            <div class="dt-legend">
                <span class="dt-legend-item"><span class="dt-leg-box" style="background:#22c55e;"></span>OK</span>
                <span class="dt-legend-item"><span class="dt-leg-box" style="background:#ef4444;"></span>PV Downtime</span>
                <span class="dt-legend-item"><span class="dt-leg-box" style="background:#1e293b;"></span>Night / No Data</span>
            </div>
            <div id="dtHeatmap" class="dt-heatmap"></div>
        </div>`;

    // Highlight active button
    el.querySelectorAll('.lt-range-btn').forEach(b=>{
        if(b.textContent.toLowerCase().includes(dtRange)) b.classList.add('active');
        else b.classList.remove('active');
    });

    // Simple downtime analysis based on predicted vs actual
    // If a daylight hour has 0 actual but >0 predicted = downtime
    let dtHours=0, lostKwh=0;
    const now=new Date();

    if(dtRange==='today'){
        const t=getToday();
        const pred=t.predicted;
        for(let h=0;h<24;h++){
            if(pred[h]>1 && (!t.hourly[h]||t.hourly[h]===0) && h<=now.getHours()){
                dtHours++;
                lostKwh+=pred[h];
            }
        }
    }

    const lostSavings=lostKwh*getTariff(now);
    document.getElementById('dtPvHours').textContent=dtHours;
    document.getElementById('dtLostKwh').textContent=fmtDec(lostKwh);
    document.getElementById('dtLostRand').textContent=fmtDec(lostSavings,2);

    // Simple heatmap for today
    if(dtRange==='today'){
        const t=getToday();
        const pred=t.predicted;
        let heatHtml='<div style="display:grid;grid-template-columns:repeat(24,1fr);gap:2px;">';
        for(let h=0;h<24;h++){
            const label=String(h).padStart(2,'0');
            let color='#1e293b'; // night
            if(pred[h]>0.5){
                if(t.hourly[h]&&t.hourly[h]>0) color='#22c55e'; // OK
                else if(h<=now.getHours()) color='#ef4444'; // downtime
            }
            heatHtml+=`<div style="text-align:center;"><div class="dt-hm-cell" style="background:${color};height:30px;" title="${label}:00"></div><div class="dt-hm-label">${label}</div></div>`;
        }
        heatHtml+='</div>';
        document.getElementById('dtHeatmap').innerHTML=heatHtml;
    }
}

// ── EDIT MODE ────────────────────────────────────────────────
function toggleEditMode(){
    document.body.classList.toggle('edit-mode');
    document.getElementById('editLayoutBtn').classList.toggle('editing');
    // Enable drag on dash-blocks
    document.querySelectorAll('.dash-block').forEach(block=>{
        block.draggable=document.body.classList.contains('edit-mode');
    });
}

function hideBlock(blockId){
    const block=document.querySelector(`[data-block="${blockId}"]`);
    if(block){block.style.display='none';block.dataset.hidden='1';}
    updateHiddenSidebar();
}
function updateHiddenSidebar(){
    const hidden=document.querySelectorAll('.dash-block[data-hidden="1"]');
    const sidebar=document.getElementById('hiddenBlocksSidebar');
    const list=document.getElementById('hiddenBlocksList');
    if(hidden.length>0){
        sidebar.classList.add('has-items');
        list.innerHTML=Array.from(hidden).map(b=>`<span class="hidden-block-item" onclick="restoreBlock('${b.dataset.block}')">${b.dataset.blockName}</span>`).join('');
    } else {
        sidebar.classList.remove('has-items');
    }
}
function restoreBlock(blockId){
    const block=document.querySelector(`[data-block="${blockId}"]`);
    if(block){block.style.display='';delete block.dataset.hidden;}
    updateHiddenSidebar();
}

// ── CALC CONFIG PANEL ────────────────────────────────────────
function toggleCalcPanel(){ document.getElementById('calcPanel').classList.toggle('open'); renderCalcPanel(); }

function renderCalcPanel(){
    const body=document.getElementById('calcPanelBody');
    const fields=[
        {section:'Environmental Factors',items:[
            {key:'env_trees',label:'Trees per kWh',unit:''},
            {key:'env_homes',label:'Homes per kWh',unit:''},
            {key:'env_coal',label:'Coal per kWh',unit:'kg'},
            {key:'env_water',label:'Water per kWh',unit:'L'}
        ]},
        {section:'Performance Thresholds',items:[
            {key:'thresh_pv_good',label:'PV Good (≥)',unit:'%'},
            {key:'thresh_pv_neutral',label:'PV Neutral (≥)',unit:'%'}
        ]},
        {section:'Degradation',items:[
            {key:'deg_annualRate',label:'Annual retention factor',unit:''}
        ]}
    ];
    body.innerHTML=fields.map(s=>`<div class="calc-section"><div class="calc-section-title">${s.section}</div>${s.items.map(i=>`<div class="calc-row"><div class="calc-label">${i.label}</div><input class="calc-input" type="number" step="any" value="${CC[i.key]}" data-key="${i.key}"><div class="calc-unit">${i.unit}</div></div>`).join('')}</div>`).join('');
}

function applyCalcConfig(){
    document.querySelectorAll('#calcPanelBody .calc-input').forEach(inp=>{
        CC[inp.dataset.key]=parseFloat(inp.value)||0;
    });
    saveCalcConfig();
    toggleCalcPanel();
    renderPublicView();
    if(isLoggedIn) renderClientOverview();
}
function resetCalcConfig(){
    CC=Object.assign({},CALC_DEFAULTS);
    saveCalcConfig();
    renderCalcPanel();
}

// ── CHART DEFAULTS ───────────────────────────────────────────
function toggleChartDefaults(){ document.getElementById('chartDefaultsPanel').classList.toggle('open'); }
function saveChartDefaults(){}
function resetChartDefaults(){}

// ── GITHUB SETUP ─────────────────────────────────────────────
function showGhSetup(){ document.getElementById('ghSetupModal').classList.add('open'); }
function closeGhSetup(){ document.getElementById('ghSetupModal').classList.remove('open'); }
function saveGhSetup(){ closeGhSetup(); }

// ── DOWNTIME COMMENTS ────────────────────────────────────────
function closeDtComment(){ document.getElementById('dtCommentModal').classList.remove('open'); }
function saveDtComment(){ closeDtComment(); }
function deleteDtComment(){ closeDtComment(); }

// ── DATASET TOGGLE (chart legends) ───────────────────────────
function toggleDs(dsName){
    const item=document.querySelector(`[data-ds="${dsName}"]`);
    if(item) item.classList.toggle('off');
    // Toggle visibility in chart
    if(charts.hourly){
        const idx=dsName==='predicted'?1:0;
        const ds=charts.hourly.data.datasets[idx];
        if(ds) ds.hidden=!ds.hidden;
        charts.hourly.update();
    }
}

// ── INIT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    const savedScale=localStorage.getItem(STORAGE_KEY+'-font');
    if(savedScale) document.documentElement.style.setProperty('--font-scale',savedScale);

    if(checkSession()){
        isLoggedIn=true;
        showClientView();
    }

    await loadData();

    // Auto-refresh every 5 minutes
    setInterval(()=>loadData(), 5*60*1000);
});
