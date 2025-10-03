(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const board = document.getElementById('board');
  const $score = document.getElementById('score');
  const $best = document.getElementById('best');
  const $status = document.getElementById('status');
  const overlay = document.getElementById('overlay');
  const startBtn = document.getElementById('startBtn');
  const btnbar = document.getElementById('btnbar');

  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  let keys = new Set();
  let touches = {left:false, right:false};
  let raf, last = performance.now(), acc = 0;

  // --- Optional: motion trails (afterimage) ---
  const TRAIL_COLOR = 'rgba(11,14,23,0.24)';  // higher alpha = shorter trails
  let TRAILS_ON = false; // flip to true if you want the effect on by default

  // Game state
  const state = {
    started:false, paused:false, over:false,
    score:0, best: Number(localStorage.getItem('dr_best')||0)
  };
  $best.textContent = state.best;

  // World uses normalized units (0..1)
  const player = { x:0.5, y:0.92, w:0.08, h:0.03, speed:0.75, vx:0 };
  const shards = [];
  let spawnTimer = 0;
  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
  const rand = (a,b)=>a + Math.random()*(b-a);

  // --- Mobile/portrait tuning ---
  let SPEED_MULT = 1;   // scales shard falling speed
  let SPAWN_MULT = 1;   // scales spawn interval (>1 = slower spawns)

  function tuneForLayout() {
    const rect = board.getBoundingClientRect();
    const portrait = rect.height >= rect.width;

    if (portrait) {
      // Bigger, slightly higher player for phone portrait
      player.w = 0.14;        // was 0.08
      player.h = 0.035;       // was 0.03
      player.y = 0.88;        // was 0.92
      player.speed = 0.90;    // a touch snappier

      // Make shards feel fairer on phones
      SPEED_MULT = 0.75;      // 25% slower vertical speed
      SPAWN_MULT = 1.25;      // spawns less frequent (interval longer)
    } else {
      // Desktop / landscape defaults
      player.w = 0.08;
      player.h = 0.03;
      player.y = 0.92;
      player.speed = 0.75;

      SPEED_MULT = 1;
      SPAWN_MULT = 1;
    }
  }

  // Resize to CSS size (DPR-aware)
  function fit(){
    const rect = board.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    // Map drawing to CSS pixels so we can use canvas.width/height safely
    ctx.setTransform(canvas.width/rect.width, 0, 0, canvas.height/rect.height, 0, 0);

    // ✅ apply portrait/desktop tuning whenever layout changes
    tuneForLayout();
  }
  new ResizeObserver(fit).observe(board);
  fit();

  // Input
  window.addEventListener('keydown', e=>{
    if(e.repeat) return;
    if(e.code==='ArrowLeft' || e.code==='KeyA') keys.add('left');
    if(e.code==='ArrowRight' || e.code==='KeyD') keys.add('right');
    if(e.code==='KeyP'){ state.paused=!state.paused; $status.textContent = state.paused?'Paused':'Engaged'; }
    if(e.code==='KeyR'){ if(state.over) start(); }
    // Optional: toggle trails quickly with V
    if(e.code==='KeyV'){ TRAILS_ON = !TRAILS_ON; $status.textContent = TRAILS_ON ? 'Trails On' : 'Trails Off'; }
  });
  window.addEventListener('keyup', e=>{
    if(e.code==='ArrowLeft' || e.code==='KeyA') keys.delete('left');
    if(e.code==='ArrowRight' || e.code==='KeyD') keys.delete('right');
  });

  // Mobile buttons
  btnbar.addEventListener('pointerdown', e=>{
    const act = e.target?.dataset?.act;
    if(act==='left') touches.left=true;
    if(act==='right') touches.right=true;
  });
  btnbar.addEventListener('pointerup', ()=>{
    touches.left=false; touches.right=false;
  });

  // Start
  startBtn.addEventListener('click', start);
  board.addEventListener('pointerdown', ()=>{ if(!state.started || state.over) start(); });

  function start(){
    state.started = true; state.paused = false; state.over=false; state.score=0;
    shards.length=0; spawnTimer=0;
    player.x=0.5; player.vx=0;
    overlay.style.display='none';
    $status.textContent = 'Engaged';
    cancelAnimationFrame(raf);
    last = performance.now(); acc=0;
    loop();
  }

  // Spawner: faster & denser as score increases
  function spawnShard(){
    const w = rand(0.05, 0.22);
    shards.push({
      x: rand(w/2+0.02, 1 - w/2 - 0.02),
      y: -0.12,
      w, h: rand(0.03, 0.06),
      // ✅ use SPEED_MULT so phones feel fairer
      vy: (rand(0.45, 0.75) * SPEED_MULT) + Math.min(0.6, state.score*0.0008*SPEED_MULT),
      rot: rand(0, Math.PI*2),
      vr: rand(-2.5, 2.5),
      glow: `rgba(255,158,100,${rand(0.6,0.9)})`
    });
  }

  // Update
  function update(dt){
    // Player movement
    let mv = 0;
    if(keys.has('left') || touches.left) mv -= 1;
    if(keys.has('right') || touches.right) mv += 1;
    player.vx = mv * player.speed;
    player.x += player.vx * dt;
    player.x = clamp(player.x, player.w/2 + 0.02, 1 - player.w/2 - 0.02);

    // Spawn logic (decreases interval as score rises)
    spawnTimer += dt;
    // ✅ use SPAWN_MULT so portrait spawns are slightly less frequent
    const base = 0.8 - state.score*0.001;
    const interval = clamp(base * SPAWN_MULT, 0.28, 1.0);
    if(spawnTimer >= interval){
      spawnTimer = 0;
      spawnShard();
    }

    // Shards update
    for(let i=shards.length-1;i>=0;i--){
      const s = shards[i];
      s.y += s.vy * dt;
      s.rot += s.vr * dt;

      // Collision (AABB-ish, using bounding boxes)
      if(rectsIntersect(player, s)){
        gameOver();
        return;
      }
      // Off-screen cleanup
      if(s.y - s.h/2 > 1.08) shards.splice(i,1);
    }

    // Score rises over time
    state.score += dt * 100; // ~100 pts/sec
    $score.textContent = Math.floor(state.score);
  }

  function rectsIntersect(a,b){
    return Math.abs(a.x - b.x) < (a.w + b.w)/2 &&
           Math.abs(a.y - b.y) < (a.h + b.h)/2;
  }

  // Draw
  function draw(){
    const w = canvas.width, h = canvas.height;

    // Trails vs full clear
    if (TRAILS_ON) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = TRAIL_COLOR;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.clearRect(0,0,w,h);
    }

    // Simple star backdrop
    const t = performance.now()*0.0002;
    for(let i=0;i<90;i++){
      const sx = (i*73.21 % 1), sy = (i*19.37 % 1);
      const y = ((sy + t*(0.08 + (i%7)*0.02)) % 1) * h;
      const x = sx * w;
      ctx.globalAlpha = .25 + (i%7)/10;
      ctx.fillStyle = '#9ad3ff';
      ctx.fillRect(x, y, 1.2+(i%3), 1.2+(i%3));
    }
    ctx.globalAlpha = 1;

    // Player
    drawRectN(player.x, player.y, player.w, player.h, '#7bdcf7', 14, 'rgba(123,220,247,.5)');

    // Shards
    for(const s of shards){
      drawRotRectN(s.x, s.y, s.w, s.h, s.rot, '#ff9e64', 10, s.glow);
    }
  }

  // Helpers to draw in normalized units (0..1)
  function drawRectN(nx, ny, nw, nh, fill, shadowBlur=0, shadowColor='transparent'){
    const x = nx*canvas.width - (nw*canvas.width)/2;
    const y = ny*canvas.height - (nh*canvas.height)/2;
    const w = nw*canvas.width, h = nh*canvas.height;
    ctx.save();
    ctx.fillStyle = fill;
    ctx.shadowBlur = shadowBlur; ctx.shadowColor = shadowColor;
    ctx.fillRect(x,y,w,h);
    ctx.restore();
  }
  function drawRotRectN(nx, ny, nw, nh, rot, fill, shadowBlur=0, shadowColor='transparent'){
    const cx = nx*canvas.width, cy = ny*canvas.height;
    const w = nw*canvas.width, h = nh*canvas.height;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.fillStyle = fill;
    ctx.shadowBlur = shadowBlur; ctx.shadowColor = shadowColor;
    ctx.fillRect(-w/2,-h/2,w,h);
    ctx.restore();
  }

  function gameOver(){
    state.over = true; state.paused = true;
    $status.textContent = 'Game Over';
    const didBeat = Math.floor(state.score) > state.best;
    if(didBeat){
      state.best = Math.floor(state.score);
      localStorage.setItem('dr_best', state.best);
      $best.textContent = state.best;
    }
    // Show overlay with restart button text
    overlay.querySelector('h2').textContent = didBeat ? 'New Best!' : 'Try Again';
    overlay.querySelector('p').innerHTML = `Score: <b>${Math.floor(state.score)}</b>${didBeat ? ' • Personal best 🎉' : ''}`;
    overlay.style.display = 'grid';
  }

  function loop(){
    raf = requestAnimationFrame(loop);
    const now = performance.now();
    let dt = (now - last)/1000; last = now;

    if(state.paused){ draw(); return; }

    // fixed-ish timestep
    acc += dt; const step = 1/120;
    while(acc >= step){ update(step); acc -= step; }
    draw();
  }

  // Start paused with overlay visible
  overlay.style.display = 'grid';
})();
