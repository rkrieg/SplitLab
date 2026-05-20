'use client';

import { useEffect, useState } from 'react';

export default function LandingPage() {
  const [navScrolled, setNavScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    function onScroll() {
      setNavScrolled(window.scrollY > 40);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  function handleCopy() {
    navigator.clipboard.writeText('<script src="https://www.trysplitlab.com/tracker.js"></script>');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div style={{ fontFamily: "'Outfit', sans-serif", background: '#0B1120', color: '#F1F5F9', minHeight: '100vh' }}>
      <style suppressHydrationWarning>{`
        :root{--brand:#3D8BDA;--brand-light:#5BA3E8;--brand-dark:#2B6FB5;--brand-glow:rgba(61,139,218,0.3);--brand-subtle:rgba(61,139,218,0.1);--bg:#0B1120;--bg-card:#111827;--bg-card-hover:#1a2338;--surface:#1E293B;--border:#1E293B;--border-light:#334155;--text:#F1F5F9;--text-muted:#94A3B8;--text-dim:#64748B;--green:#22C55E;--green-bg:rgba(34,197,94,0.1)}
        *{margin:0;padding:0;box-sizing:border-box}html{scroll-behavior:smooth}body{font-family:'Outfit',sans-serif;background:var(--bg);color:var(--text);line-height:1.6;overflow-x:hidden;-webkit-font-smoothing:antialiased}
        nav{position:fixed;top:0;width:100%;z-index:100;padding:8px 0;transition:background .3s,backdrop-filter .3s}nav.scrolled{background:rgba(11,17,32,0.85);backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}.nav-inner{max-width:1140px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between}.nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none}.nav-logo img{height:180px;width:auto}.nav-logo-icon{width:34px;height:34px;background:var(--brand);border-radius:9px;display:flex;align-items:center;justify-content:center}.nav-logo-icon svg{width:18px;height:18px;color:white}.nav-logo-text{font-weight:700;font-size:21px;color:var(--text)}.nav-logo-text span{color:var(--brand)}.nav-links{display:flex;align-items:center;gap:32px}.nav-links a{color:var(--text-muted);text-decoration:none;font-size:15px;font-weight:500;transition:color .2s}.nav-links a:hover{color:var(--text)}.nav-login{border:1px solid var(--border-light)!important;color:var(--text)!important;padding:9px 20px!important;border-radius:8px;font-weight:600!important;transition:all .2s!important}.nav-login:hover{border-color:var(--brand)!important;color:var(--brand-light)!important}.nav-cta{background:var(--brand)!important;color:white!important;padding:9px 22px!important;border-radius:8px;font-weight:600!important;transition:all .2s!important}.nav-cta:hover{background:var(--brand-light)!important}.mobile-toggle{display:none;background:none;border:none;color:var(--text);cursor:pointer}
        .hero{position:relative;padding:155px 24px 85px;text-align:center;overflow:hidden}.hero::before{content:'';position:absolute;top:-200px;left:50%;transform:translateX(-50%);width:900px;height:900px;background:radial-gradient(circle,rgba(61,139,218,0.1) 0%,transparent 70%);pointer-events:none}.hero-badge{display:inline-flex;align-items:center;gap:8px;padding:7px 16px;background:var(--brand-subtle);border:1px solid rgba(61,139,218,0.2);border-radius:100px;font-size:13px;color:var(--brand-light);font-weight:600;margin-bottom:28px;animation:fadeUp .5s ease}.hero-badge .dot{width:7px;height:7px;background:var(--green);border-radius:50%;animation:pulse 2s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}.hero h1{font-size:clamp(38px,5.5vw,66px);font-weight:800;line-height:1.08;letter-spacing:-.03em;margin-bottom:22px;animation:fadeUp .5s ease .05s both}.hero h1 .gradient{background:linear-gradient(135deg,#3D8BDA,#6366F1);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}.hero-sub{font-size:clamp(17px,2vw,20px);color:var(--text-muted);max-width:600px;margin:0 auto 44px;line-height:1.65;animation:fadeUp .5s ease .1s both}.hero-ctas{display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;animation:fadeUp .5s ease .15s both}.btn-primary{display:inline-flex;align-items:center;gap:8px;padding:15px 32px;background:var(--brand);color:white;border:none;border-radius:10px;font-size:16px;font-weight:600;font-family:inherit;cursor:pointer;text-decoration:none;transition:all .2s;box-shadow:0 0 30px var(--brand-glow)}.btn-primary:hover{background:var(--brand-light);transform:translateY(-2px);box-shadow:0 0 50px var(--brand-glow)}.btn-secondary{display:inline-flex;align-items:center;gap:8px;padding:15px 32px;background:transparent;color:var(--text);border:1px solid var(--border-light);border-radius:10px;font-size:16px;font-weight:600;font-family:inherit;cursor:pointer;text-decoration:none;transition:all .2s}.btn-secondary:hover{border-color:var(--text-dim);transform:translateY(-2px)}.hero-proof{display:flex;align-items:center;justify-content:center;gap:28px;margin-top:48px;flex-wrap:wrap;animation:fadeUp .5s ease .2s both}.hero-proof-item{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text-dim);font-weight:500}.hero-proof-item svg{width:16px;height:16px;color:var(--green)}@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
        .demo-section{max-width:1020px;margin:0 auto 110px;padding:0 24px;animation:fadeUp .5s ease .25s both}.demo-window{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;overflow:hidden;box-shadow:0 25px 80px rgba(0,0,0,0.4),0 0 60px rgba(61,139,218,0.05)}.demo-titlebar{display:flex;align-items:center;gap:7px;padding:13px 18px;background:var(--surface);border-bottom:1px solid var(--border)}.demo-dot{width:11px;height:11px;border-radius:50%}.demo-dot.r{background:#EF4444}.demo-dot.y{background:#EAB308}.demo-dot.g{background:#22C55E}.demo-url{flex:1;margin-left:10px;padding:5px 14px;background:rgba(0,0,0,0.3);border-radius:6px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-dim)}.demo-body{padding:28px}.demo-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.demo-variant{background:var(--surface);border-radius:10px;padding:22px;border:1px solid var(--border);position:relative}.demo-variant-tag{position:absolute;top:12px;right:12px;padding:3px 10px;border-radius:5px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}.tag-control{background:rgba(34,197,94,0.12);color:var(--green)}.tag-variant{background:var(--brand-subtle);color:var(--brand-light)}.demo-variant h4{font-size:15px;font-weight:600;margin-bottom:3px}.demo-variant-url{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-dim);margin-bottom:16px}.demo-stats{display:flex;gap:20px}.demo-stat-label{font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;font-weight:500}.demo-stat-value{font-size:22px;font-weight:700}.demo-stat-value.green{color:var(--green)}.demo-stat-value.brand{color:var(--brand-light)}.demo-bar{margin-top:16px;display:flex;align-items:center;gap:10px}.demo-bar-track{flex:1;height:5px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden}.demo-bar-fill{height:100%;border-radius:3px}.demo-bar-label{font-size:12px;color:var(--text-dim);min-width:36px;text-align:right}.demo-confidence{margin-top:20px;padding:14px 18px;background:var(--green-bg);border:1px solid rgba(34,197,94,0.2);border-radius:10px;display:flex;align-items:center;gap:10px}.demo-confidence svg{width:18px;height:18px;color:var(--green);flex-shrink:0}.demo-confidence-text{font-size:14px;color:var(--green);font-weight:600}
        .section-label{text-align:center;font-size:13px;font-weight:700;color:var(--brand);text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px}.section-title{text-align:center;font-size:clamp(30px,3.8vw,44px);font-weight:800;letter-spacing:-.025em;margin-bottom:14px}.section-sub{text-align:center;font-size:17px;color:var(--text-muted);max-width:540px;margin:0 auto 56px}
        .features{max-width:1140px;margin:0 auto;padding:80px 24px}.features-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.feature-card{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:28px;transition:all .3s;position:relative;overflow:hidden}.feature-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(135deg,#3D8BDA,#6366F1);opacity:0;transition:opacity .3s}.feature-card:hover{background:var(--bg-card-hover);border-color:var(--border-light);transform:translateY(-4px)}.feature-card:hover::before{opacity:1}.feature-icon{width:44px;height:44px;background:var(--brand-subtle);border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:18px}.feature-icon svg{width:22px;height:22px;color:var(--brand-light);stroke-width:1.8}.feature-card h3{font-size:17px;font-weight:700;margin-bottom:8px}.feature-card p{font-size:14.5px;color:var(--text-muted);line-height:1.6}
        .how-it-works{max-width:1140px;margin:0 auto;padding:80px 24px}.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:28px;max-width:1000px;margin:0 auto}.step{text-align:center;position:relative}.step::after{content:'';position:absolute;top:28px;right:-14px;width:28px;height:1px;background:var(--border-light)}.step:last-child::after{display:none}.step-num{width:56px;height:56px;margin:0 auto 16px;background:var(--brand-subtle);border:1.5px solid rgba(61,139,218,0.2);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;color:var(--brand-light)}.step h3{font-size:16px;font-weight:700;margin-bottom:6px}.step p{font-size:13.5px;color:var(--text-muted);line-height:1.55}
        .snippet-section{max-width:720px;margin:0 auto;padding:80px 24px}.snippet-box{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.2)}.snippet-header{display:flex;align-items:center;justify-content:space-between;padding:12px 18px;background:var(--surface);border-bottom:1px solid var(--border)}.snippet-header span{font-size:12px;color:var(--text-dim);font-weight:500}.snippet-copy{padding:5px 12px;background:var(--brand-subtle);border:1px solid rgba(61,139,218,0.2);border-radius:5px;color:var(--brand-light);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s}.snippet-copy:hover{background:rgba(61,139,218,0.2)}.snippet-code{padding:22px;font-family:'JetBrains Mono',monospace;font-size:14px;line-height:1.8;color:var(--text-muted);overflow-x:auto}.snippet-code .tag{color:var(--brand-light)}.snippet-code .attr{color:#EAB308}.snippet-code .str{color:var(--green)}.snippet-code .comment{color:var(--text-dim)}.snippet-label{text-align:center;margin-top:18px;font-size:15px;color:var(--text-dim)}.snippet-label strong{color:var(--text-muted)}
        .use-cases{max-width:1140px;margin:0 auto;padding:80px 24px}.use-case-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}.use-case{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:28px;transition:all .3s}.use-case:hover{border-color:var(--border-light)}.use-case-tag{display:inline-block;padding:3px 10px;background:var(--brand-subtle);border-radius:5px;font-size:12px;font-weight:600;color:var(--brand-light);margin-bottom:14px}.use-case h3{font-size:18px;font-weight:700;margin-bottom:8px}.use-case p{font-size:14.5px;color:var(--text-muted);line-height:1.6}
        .pricing{max-width:1140px;margin:0 auto;padding:80px 24px}.pricing-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:56px}.pricing-card{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:28px;display:flex;flex-direction:column;transition:all .3s;position:relative}.pricing-card:hover{border-color:var(--border-light);transform:translateY(-4px)}.pricing-card.featured{border-color:var(--brand);box-shadow:0 0 40px rgba(61,139,218,0.1)}.pricing-card.featured::before{content:'Most Popular';position:absolute;top:-12px;left:50%;transform:translateX(-50%);padding:4px 14px;background:var(--brand);color:white;border-radius:100px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}.pricing-plan{font-size:15px;font-weight:700;color:var(--text);margin-bottom:4px}.pricing-price{font-size:40px;font-weight:800;letter-spacing:-.03em;margin-bottom:4px}.pricing-price span{font-size:16px;font-weight:500;color:var(--text-dim)}.pricing-desc{font-size:13px;color:var(--text-dim);margin-bottom:24px;min-height:36px}.pricing-features{list-style:none;margin-bottom:28px;flex:1}.pricing-features li{display:flex;align-items:flex-start;gap:8px;font-size:14px;color:var(--text-muted);margin-bottom:10px;line-height:1.45}.pricing-features li svg{width:16px;height:16px;color:var(--green);flex-shrink:0;margin-top:2px}.pricing-btn{display:block;text-align:center;padding:12px;border-radius:8px;font-size:15px;font-weight:600;text-decoration:none;transition:all .2s;font-family:inherit;cursor:pointer;border:none;width:100%}.pricing-btn-primary{background:var(--brand);color:white}.pricing-btn-primary:hover{background:var(--brand-light)}.pricing-btn-secondary{background:transparent;color:var(--text);border:1px solid var(--border-light)}.pricing-btn-secondary:hover{background:var(--surface)}.pricing-btn-outline{background:transparent;color:var(--brand-light);border:1px solid var(--brand)}.pricing-btn-outline:hover{background:var(--brand-subtle)}
        .final-cta{text-align:center;padding:110px 24px;position:relative}.final-cta::before{content:'';position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:800px;height:600px;background:radial-gradient(circle,rgba(61,139,218,0.08) 0%,transparent 70%);pointer-events:none}.final-cta h2{font-size:clamp(30px,3.8vw,48px);font-weight:800;letter-spacing:-.025em;margin-bottom:14px}.final-cta h2 .gradient{background:linear-gradient(135deg,#3D8BDA,#6366F1);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}.final-cta p{font-size:17px;color:var(--text-muted);margin-bottom:36px;max-width:460px;margin-left:auto;margin-right:auto}
        footer{border-top:1px solid var(--border);padding:40px 24px}.footer-inner{max-width:1140px;margin:0 auto;display:flex;align-items:center;justify-content:space-between}.footer-left{display:flex;align-items:center;gap:10px}.footer-logo{width:26px;height:26px;background:var(--brand);border-radius:7px;display:flex;align-items:center;justify-content:center}.footer-logo svg{width:14px;height:14px;color:white}.footer-copy{font-size:13px;color:var(--text-dim)}.footer-links{display:flex;gap:24px}.footer-links a{font-size:13px;color:var(--text-dim);text-decoration:none;transition:color .2s}.footer-links a:hover{color:var(--text)}
        @media(max-width:900px){.features-grid{grid-template-columns:repeat(2,1fr)}.steps{grid-template-columns:repeat(2,1fr)}.step::after{display:none}.demo-grid{grid-template-columns:1fr}.pricing-grid{grid-template-columns:repeat(2,1fr)}.nav-links{display:none}.mobile-toggle{display:block}}
        @media(max-width:600px){.features-grid{grid-template-columns:1fr}.steps{grid-template-columns:1fr}.use-case-grid{grid-template-columns:1fr}.pricing-grid{grid-template-columns:1fr}.hero{padding:120px 20px 60px}.hero-ctas{flex-direction:column}.btn-primary,.btn-secondary{width:100%;justify-content:center}.footer-inner{flex-direction:column;gap:14px}}
        .nav-links.show{display:flex!important;flex-direction:column;position:fixed;top:62px;left:0;right:0;background:rgba(11,17,32,0.97);padding:20px 24px;gap:16px;border-bottom:1px solid var(--border-light);z-index:99}
      `}</style>

      <nav id="nav" className={navScrolled ? 'scrolled' : ''}>
        <div className="nav-inner">
          <a href="#" className="nav-logo">
            <img src="/splitlab-logo-dark.png" alt="SplitLab" />
          </a>
          <div className={`nav-links${mobileOpen ? ' show' : ''}`}>
            <a href="#features">Features</a>
            <a href="#how-it-works">How It Works</a>
            <a href="#pricing">Pricing</a>
            <a href="#use-cases">Use Cases</a>
            <a href="/login" className="nav-login">Log In</a>
            <a href="/login" className="nav-cta">Get Started</a>
          </div>
          <button className="mobile-toggle" onClick={() => setMobileOpen(!mobileOpen)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-badge"><span className="dot"></span> Now in Beta</div>
        <h1>A/B Test <span className="gradient">Any URL</span><br />In Under 5 Minutes</h1>
        <p className="hero-sub">Route traffic through your domain. Test Lovable pages, Replit apps, raw HTML, or any URL. One script tag for conversion tracking. Statistical confidence built in.</p>
        <div className="hero-ctas">
          <a href="/login" className="btn-primary">Start Testing Free <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg></a>
          <a href="#how-it-works" className="btn-secondary">See How It Works</a>
        </div>
        <div className="hero-proof">
          <div className="hero-proof-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> No code required</div>
          <div className="hero-proof-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Zero-config tracking</div>
          <div className="hero-proof-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Free to start</div>
        </div>
      </section>

      <section className="demo-section">
        <div className="demo-window">
          <div className="demo-titlebar">
            <div className="demo-dot r"></div>
            <div className="demo-dot y"></div>
            <div className="demo-dot g"></div>
            <div className="demo-url">trysplitlab.com/dashboard/tests/chat-gpt-ads</div>
          </div>
          <div className="demo-body">
            <div className="demo-grid">
              <div className="demo-variant">
                <span className="demo-variant-tag tag-control">Control</span>
                <h4>Original Page</h4>
                <div className="demo-variant-url">chatgptlawads.com</div>
                <div className="demo-stats">
                  <div><div className="demo-stat-label">Views</div><div className="demo-stat-value">1,247</div></div>
                  <div><div className="demo-stat-label">Conversions</div><div className="demo-stat-value">38</div></div>
                  <div><div className="demo-stat-label">CVR</div><div className="demo-stat-value brand">3.0%</div></div>
                </div>
                <div className="demo-bar"><div className="demo-bar-track"><div className="demo-bar-fill" style={{width:'30%',background:'var(--brand)'}}></div></div><div className="demo-bar-label">50%</div></div>
              </div>
              <div className="demo-variant">
                <span className="demo-variant-tag tag-variant">Variant B</span>
                <h4>AI-Generated Variant</h4>
                <div className="demo-variant-url">variants.trysplitlab.com/abc123</div>
                <div className="demo-stats">
                  <div><div className="demo-stat-label">Views</div><div className="demo-stat-value">1,189</div></div>
                  <div><div className="demo-stat-label">Conversions</div><div className="demo-stat-value">62</div></div>
                  <div><div className="demo-stat-label">CVR</div><div className="demo-stat-value green">5.2%</div></div>
                </div>
                <div className="demo-bar"><div className="demo-bar-track"><div className="demo-bar-fill" style={{width:'52%',background:'var(--green)'}}></div></div><div className="demo-bar-label">50%</div></div>
              </div>
            </div>
            <div className="demo-confidence">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              <span className="demo-confidence-text">Variant B is winning with 97.3% statistical confidence. +73% lift in conversion rate.</span>
            </div>
          </div>
        </div>
      </section>

      <section className="features" id="features">
        <div className="section-label">Features</div>
        <h2 className="section-title">Everything you need to test and win</h2>
        <p className="section-sub">Built for agencies and marketers who need fast answers, not enterprise complexity.</p>
        <div className="features-grid">
          <div className="feature-card"><div className="feature-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></div><h3>Test Any URL</h3><p>Paste any URL as a variant. Lovable, Replit, Webflow, WordPress, static HTML. If it has a URL, SplitLab can test it.</p></div>
          <div className="feature-card"><div className="feature-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></div><h3>Paste Raw HTML</h3><p>Don&apos;t have a hosted page? Paste your HTML directly into SplitLab. We host it, inject tracking, and serve it as a variant.</p></div>
          <div className="feature-card"><div className="feature-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div><h3>Your Domain, Your Rules</h3><p>Route traffic through your own domain. Visitors see your URL while SplitLab handles the split testing behind the scenes.</p></div>
          <div className="feature-card"><div className="feature-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></div><h3>Zero-Config Tracking</h3><p>One script tag. No API keys. No SDK. tracker.js auto-detects variants, tracks form submissions, and persists attribution for 30 days.</p></div>
          <div className="feature-card"><div className="feature-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div><h3>Add Custom Scripts</h3><p>Inject any tracking pixel, analytics script, or custom JavaScript per variant. Meta Pixel, Google Tag Manager, Hyros, CallRail.</p></div>
          <div className="feature-card"><div className="feature-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div><h3>Statistical Confidence</h3><p>Chi-square testing with automatic winner detection at 95%+ confidence. Know when you have a real winner, not a lucky streak.</p></div>
        </div>
      </section>

      <section className="how-it-works" id="how-it-works">
        <div className="section-label">How It Works</div>
        <h2 className="section-title">Live in under 5 minutes</h2>
        <p className="section-sub">No dev team needed. No complex setup. Just URLs and results.</p>
        <div className="steps">
          <div className="step"><div className="step-num">1</div><h3>Add Your URLs</h3><p>Paste the URLs you want to test. External sites, hosted pages, or raw HTML.</p></div>
          <div className="step"><div className="step-num">2</div><h3>Set Traffic Split</h3><p>Adjust weights per variant. 50/50, 70/30, or any combination. Change anytime.</p></div>
          <div className="step"><div className="step-num">3</div><h3>Add Tracker</h3><p>Drop one script tag on your pages. Conversions tracked automatically.</p></div>
          <div className="step"><div className="step-num">4</div><h3>Find Your Winner</h3><p>Watch results in real time. SplitLab tells you when a variant wins with confidence.</p></div>
        </div>
      </section>

      <section className="snippet-section">
        <div className="section-label">One Line of Code</div>
        <h2 className="section-title" style={{marginBottom:'40px'}}>That&apos;s the entire setup</h2>
        <div className="snippet-box">
          <div className="snippet-header">
            <span>HTML</span>
            <button className="snippet-copy" onClick={handleCopy}>{copied ? 'Copied!' : 'Copy'}</button>
          </div>
          <div className="snippet-code">
            <span className="comment">&lt;!-- Add before &lt;/body&gt; on every page you&apos;re testing --&gt;</span><br />
            <span className="tag">&lt;script</span> <span className="attr">src</span>=<span className="str">&quot;https://www.trysplitlab.com/tracker.js&quot;</span><span className="tag">&gt;&lt;/script&gt;</span>
          </div>
        </div>
        <p className="snippet-label">No API keys. No configuration. <strong>It just works.</strong></p>
      </section>

      <section className="use-cases" id="use-cases">
        <div className="section-label">Built For</div>
        <h2 className="section-title">Agencies and marketers who move fast</h2>
        <p className="section-sub">SplitLab is designed for people who build landing pages and need to know which one converts.</p>
        <div className="use-case-grid">
          <div className="use-case"><div className="use-case-tag">Lead Generation</div><h3>Law Firms &amp; Legal Marketing</h3><p>Test multiple landing pages for personal injury, family law, or criminal defense campaigns. Track form fills and phone calls as conversions.</p></div>
          <div className="use-case"><div className="use-case-tag">Real Estate</div><h3>Investment &amp; Syndication</h3><p>Compare accredited investor landing pages across different value propositions. Optimize lead quality by testing form fields and qualifying questions.</p></div>
          <div className="use-case"><div className="use-case-tag">SaaS</div><h3>Software Signups &amp; Demos</h3><p>Test pricing pages, feature highlights, and demo request flows. Track trial signups and demo bookings as conversion goals.</p></div>
          <div className="use-case"><div className="use-case-tag">Local Services</div><h3>Contractors, Medical &amp; Dental</h3><p>Compare service pages, special offer variations, and booking flows. Track form submissions and click-to-call conversions.</p></div>
        </div>
      </section>

      <section className="pricing" id="pricing">
        <div className="section-label">Pricing</div>
        <h2 className="section-title">Simple, transparent pricing</h2>
        <p className="section-sub">Start free. Upgrade when you need more. No contracts, cancel anytime.</p>
        <div className="pricing-grid">
          <div className="pricing-card">
            <div className="pricing-plan">Starter</div>
            <div className="pricing-price">Free</div>
            <div className="pricing-desc">Perfect for trying SplitLab out</div>
            <ul className="pricing-features">
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>1 active test</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>2 variants per test</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>1,000 visitors/mo</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Basic analytics</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Zero-config tracker.js</li>
            </ul>
            <a href="/login" className="pricing-btn pricing-btn-secondary">Get Started</a>
          </div>
          <div className="pricing-card">
            <div className="pricing-plan">Pro</div>
            <div className="pricing-price">$49<span>/mo</span></div>
            <div className="pricing-desc">For marketers running real tests</div>
            <ul className="pricing-features">
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>10 active tests</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Unlimited variants</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>25,000 visitors/mo</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>1 custom domain</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>CSV export</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Conversion goals</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Priority email support</li>
            </ul>
            <a href="/login" className="pricing-btn pricing-btn-outline">Get Started</a>
          </div>
          <div className="pricing-card featured">
            <div className="pricing-plan">Agency</div>
            <div className="pricing-price">$149<span>/mo</span></div>
            <div className="pricing-desc">For agencies managing multiple clients</div>
            <ul className="pricing-features">
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>50 active tests</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Up to 10 clients</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>100,000 visitors/mo</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Up to 10 custom domains</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Team seats</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Custom scripts per variant</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>UTM personalization</li>
            </ul>
            <a href="/login" className="pricing-btn pricing-btn-primary">Get Started</a>
          </div>
          <div className="pricing-card">
            <div className="pricing-plan">Scale</div>
            <div className="pricing-price">$349<span>/mo</span></div>
            <div className="pricing-desc">For high-volume teams and networks</div>
            <ul className="pricing-features">
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Unlimited tests</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Unlimited clients</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Unlimited visitors/mo</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Unlimited custom domains</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>White-label branding</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Webhook integrations</li>
              <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Priority support</li>
            </ul>
            <a href="/login" className="pricing-btn pricing-btn-secondary">Get Started</a>
          </div>
        </div>
      </section>

      <section className="final-cta">
        <h2>Ready to find your<br /><span className="gradient">winning page?</span></h2>
        <p>Start testing today. Your first test can be live in under 5 minutes.</p>
        <a href="/login" className="btn-primary">Get Started <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg></a>
      </section>

      <footer>
        <div className="footer-inner">
          <div className="footer-left">
            <img src="/splitlab-logo-dark.png" alt="SplitLab" style={{height:'60px',width:'auto'}} />
            <span className="footer-copy">&copy; 2026 SplitLab. Built by Infinity Media.</span>
          </div>
          <div className="footer-links"><a href="#">Privacy</a><a href="#">Terms</a><a href="#">Support</a></div>
        </div>
      </footer>
    </div>
  );
}
