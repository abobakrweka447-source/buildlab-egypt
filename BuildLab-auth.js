/*
 * BuildLab Egypt — Account Authentication UI
 * Uses the existing Supabase client created by the AI adviser.
 * Required bridge in index.html, immediately after AI_SUPABASE is created:
 *   window.BuildLabSupabase = AI_SUPABASE;
 *   window.dispatchEvent(new Event('buildlab:supabase-ready'));
 * Load this file after the main inline application script:
 *   <script src="/auth.js"></script>
 */
(function () {
  'use strict';

  var PANEL_SELECTOR = '.auth-preview';
  var panel = null;
  var supabaseClient = null;
  var authSubscription = null;
  var mode = 'login';
  var busy = false;
  var recoverySession = false;

  function byId(id) {
    return panel ? panel.querySelector('#' + id) : null;
  }

  function setStatus(message, kind) {
    var status = byId('buildlab-account-status');
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('error', kind === 'error');
    status.hidden = !message;
  }

  function friendlyError(error) {
    var message = String(error && error.message ? error.message : error || 'حدث خطأ غير متوقع.');
    var lower = message.toLowerCase();

    if (lower.includes('invalid login credentials')) return 'البريد الإلكتروني أو كلمة المرور غير صحيحة.';
    if (lower.includes('email not confirmed')) return 'أكد بريدك الإلكتروني من الرسالة التي وصلتك، ثم سجّل الدخول.';
    if (lower.includes('user already registered')) return 'هذا البريد مسجل بالفعل. جرّب تسجيل الدخول بدل إنشاء حساب جديد.';
    if (lower.includes('password should be at least')) return 'كلمة المرور أقصر من الحد المطلوب. استخدم 8 أحرف على الأقل.';
    if (lower.includes('password') && lower.includes('characters')) return 'كلمة المرور لا تستوفي شروط الأمان المطلوبة.';
    if (lower.includes('email') && (lower.includes('invalid') || lower.includes('valid'))) return 'اكتب بريدًا إلكترونيًا صحيحًا.';
    if (lower.includes('rate limit') || lower.includes('too many requests')) return 'محاولات كثيرة في وقت قصير. انتظر قليلًا ثم حاول مرة أخرى.';
    if (lower.includes('network') || lower.includes('fetch')) return 'تعذر الاتصال بخدمة الحسابات. تحقق من الإنترنت وحاول مرة أخرى.';

    return message;
  }

  function renderPanel() {
    if (!panel) return;

    panel.innerHTML = `
      <div class="auth-tabs" role="tablist" aria-label="نوع الحساب">
        <button class="auth-tab active" id="buildlab-account-login-tab" type="button" role="tab" aria-selected="true" data-account-mode="login">تسجيل الدخول</button>
        <button class="auth-tab" id="buildlab-account-signup-tab" type="button" role="tab" aria-selected="false" data-account-mode="signup">إنشاء حساب</button>
      </div>

      <div class="auth-heading">
        <h2 id="buildlab-account-title">أهلًا بعودتك</h2>
        <p id="buildlab-account-description">ادخل لحسابك عشان تكمل من حيث وقفت.</p>
      </div>

      <form id="buildlab-account-form" novalidate>
        <label class="form-label" id="buildlab-account-email-wrap">
          البريد الإلكتروني
          <input class="field" id="buildlab-account-email" name="email" type="email" inputmode="email" autocomplete="email" maxlength="254" placeholder="name@example.com" required>
        </label>

        <label class="form-label" id="buildlab-account-password-wrap">
          <span id="buildlab-account-password-label">كلمة المرور</span>
          <input class="field" id="buildlab-account-password" name="password" type="password" autocomplete="current-password" minlength="8" maxlength="72" placeholder="8 أحرف على الأقل" required>
        </label>

        <div class="auth-inline" id="buildlab-account-options">
          <span class="fineprint">تُحفظ جلستك على هذا الجهاز لتسهيل الدخول لاحقًا.</span>
          <button class="muted-link" id="buildlab-account-forgot" type="button" style="background:none;border:0;padding:0;font:inherit;cursor:pointer">نسيت كلمة المرور؟</button>
        </div>

        <button class="btn primary auth-submit" id="buildlab-account-submit" type="submit">تسجيل الدخول <span>←</span></button>
      </form>

      <div class="auth-separator" id="buildlab-account-separator"><span>أو</span></div>
      <button class="btn auth-secondary" id="buildlab-account-switch" type="button">إنشاء حساب جديد</button>

      <p class="ai-meta ai-notice" id="buildlab-account-status" role="status" aria-live="polite" hidden></p>

      <div id="buildlab-account-session" hidden>
        <div class="ai-notice">
          <strong>تم تسجيل الدخول بنجاح.</strong>
          <div class="fineprint" style="margin-top:5px">الحساب نفسه مستخدم في مستشار BuildLab AI.</div>
        </div>
        <div class="ai-session-head">
          <span class="ai-session-email" id="buildlab-account-user-email"></span>
          <button class="btn small danger" id="buildlab-account-logout" type="button">تسجيل الخروج</button>
        </div>
      </div>

      <p class="fineprint auth-footnote" id="buildlab-account-footnote">تسجيل الدخول وإنشاء الحساب يتمان عبر Supabase. لا تشارك كلمة مرورك مع أي شخص.</p>
    `;

    byId('buildlab-account-form').addEventListener('submit', handleSubmit);
    byId('buildlab-account-login-tab').addEventListener('click', function () { setMode('login'); });
    byId('buildlab-account-signup-tab').addEventListener('click', function () { setMode('signup'); });
    byId('buildlab-account-switch').addEventListener('click', function () {
      setMode(mode === 'signup' ? 'login' : 'signup');
    });
    byId('buildlab-account-forgot').addEventListener('click', handleForgotPassword);
    byId('buildlab-account-logout').addEventListener('click', handleLogout);

    setMode('login');
  }

  function setMode(nextMode) {
    mode = nextMode;
    recoverySession = nextMode === 'recovery';

    var loginTab = byId('buildlab-account-login-tab');
    var signupTab = byId('buildlab-account-signup-tab');
    var title = byId('buildlab-account-title');
    var description = byId('buildlab-account-description');
    var submit = byId('buildlab-account-submit');
    var switchButton = byId('buildlab-account-switch');
    var options = byId('buildlab-account-options');
    var separator = byId('buildlab-account-separator');
    var emailWrap = byId('buildlab-account-email-wrap');
    var passwordLabel = byId('buildlab-account-password-label');
    var password = byId('buildlab-account-password');
    var footnote = byId('buildlab-account-footnote');

    if (!title || !submit) return;

    loginTab.hidden = recoverySession;
    signupTab.hidden = recoverySession;
    loginTab.classList.toggle('active', mode === 'login');
    signupTab.classList.toggle('active', mode === 'signup');
    loginTab.setAttribute('aria-selected', String(mode === 'login'));
    signupTab.setAttribute('aria-selected', String(mode === 'signup'));

    if (mode === 'signup') {
      title.textContent = 'إنشاء حساب جديد';
      description.textContent = 'استخدم بريدك الإلكتروني وأنشئ كلمة مرور لحسابك.';
      submit.innerHTML = 'إنشاء الحساب <span>←</span>';
      switchButton.textContent = 'لديك حساب بالفعل؟ تسجيل الدخول';
      options.hidden = true;
      separator.hidden = true;
      switchButton.hidden = false;
      emailWrap.hidden = false;
      passwordLabel.textContent = 'كلمة المرور (8 أحرف على الأقل)';
      password.autocomplete = 'new-password';
      password.placeholder = '8 أحرف على الأقل';
      footnote.textContent = 'قد يطلب منك تأكيد بريدك الإلكتروني قبل أول تسجيل دخول.';
    } else if (recoverySession) {
      title.textContent = 'تعيين كلمة مرور جديدة';
      description.textContent = 'اكتب كلمة مرور جديدة لحسابك.';
      submit.innerHTML = 'حفظ كلمة المرور <span>←</span>';
      switchButton.hidden = true;
      options.hidden = true;
      separator.hidden = true;
      emailWrap.hidden = true;
      passwordLabel.textContent = 'كلمة المرور الجديدة';
      password.autocomplete = 'new-password';
      password.placeholder = '8 أحرف على الأقل';
      footnote.textContent = 'بعد الحفظ ستتمكن من استخدام كلمة المرور الجديدة في تسجيل الدخول.';
    } else {
      title.textContent = 'أهلًا بعودتك';
      description.textContent = 'ادخل لحسابك عشان تكمل من حيث وقفت.';
      submit.innerHTML = 'تسجيل الدخول <span>←</span>';
      switchButton.textContent = 'إنشاء حساب جديد';
      switchButton.hidden = false;
      options.hidden = false;
      separator.hidden = false;
      emailWrap.hidden = false;
      passwordLabel.textContent = 'كلمة المرور';
      password.autocomplete = 'current-password';
      password.placeholder = 'اكتب كلمة المرور';
      footnote.textContent = 'تسجيل الدخول وإنشاء الحساب يتمان عبر Supabase. لا تشارك كلمة مرورك مع أي شخص.';
    }

    setStatus('', 'info');
    updateBusyState(false);
  }

  function updateBusyState(value) {
    busy = Boolean(value);
    var ids = [
      'buildlab-account-login-tab',
      'buildlab-account-signup-tab',
      'buildlab-account-switch',
      'buildlab-account-forgot',
      'buildlab-account-submit',
      'buildlab-account-logout'
    ];
    ids.forEach(function (id) {
      var element = byId(id);
      if (element) element.disabled = busy;
    });
    var email = byId('buildlab-account-email');
    var password = byId('buildlab-account-password');
    if (email) email.disabled = busy;
    if (password) password.disabled = busy;
  }

  function renderSession(session) {
    if (!panel) return;
    var sessionBox = byId('buildlab-account-session');
    var form = byId('buildlab-account-form');
    var tabs = panel.querySelector('.auth-tabs');
    var heading = panel.querySelector('.auth-heading');
    var separator = byId('buildlab-account-separator');
    var switchButton = byId('buildlab-account-switch');
    var emailLabel = byId('buildlab-account-user-email');
    var hasSession = Boolean(session && session.user);

    if (hasSession && !recoverySession) {
      if (form) form.hidden = true;
      if (tabs) tabs.hidden = true;
      if (heading) heading.hidden = true;
      if (separator) separator.hidden = true;
      if (switchButton) switchButton.hidden = true;
      if (sessionBox) sessionBox.hidden = false;
      if (emailLabel) emailLabel.textContent = session.user.email || 'حساب BuildLab';
      setStatus('', 'info');
    } else {
      if (form) form.hidden = false;
      if (tabs) tabs.hidden = recoverySession;
      if (heading) heading.hidden = false;
      if (sessionBox) sessionBox.hidden = true;
      if (!recoverySession && separator) separator.hidden = false;
      if (!recoverySession && switchButton) switchButton.hidden = false;
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;

    if (!supabaseClient || !supabaseClient.auth) {
      setStatus('نظام الحسابات لم يكتمل تحميله بعد. حدّث الصفحة وحاول مرة أخرى.', 'error');
      return;
    }

    var emailInput = byId('buildlab-account-email');
    var passwordInput = byId('buildlab-account-password');
    var email = emailInput ? emailInput.value.trim() : '';
    var password = passwordInput ? passwordInput.value : '';

    if (mode !== 'recovery' && !email) {
      setStatus('اكتب البريد الإلكتروني أولًا.', 'error');
      if (emailInput) emailInput.focus();
      return;
    }

    if (!password || password.length < 8) {
      setStatus('كلمة المرور لازم تكون 8 أحرف على الأقل.', 'error');
      if (passwordInput) passwordInput.focus();
      return;
    }

    updateBusyState(true);
    setStatus(mode === 'signup' ? 'جارٍ إنشاء الحساب…' : mode === 'recovery' ? 'جارٍ تحديث كلمة المرور…' : 'جارٍ تسجيل الدخول…', 'info');

    try {
      if (mode === 'signup') {
        var signUpResult = await supabaseClient.auth.signUp({
          email: email,
          password: password,
          options: { emailRedirectTo: window.location.origin + '/' }
        });
        if (signUpResult.error) throw signUpResult.error;

        if (signUpResult.data && signUpResult.data.session) {
          setStatus('تم إنشاء الحساب وتسجيل الدخول بنجاح.', 'info');
        } else {
          setMode('login');
          setStatus('تم إنشاء الحساب. افتح رسالة التأكيد التي أُرسلت إلى بريدك الإلكتروني، ثم ارجع لتسجيل الدخول.', 'info');
        }
      } else if (mode === 'recovery') {
        var updateResult = await supabaseClient.auth.updateUser({ password: password });
        if (updateResult.error) throw updateResult.error;
        mode = 'login';
        recoverySession = false;
        setStatus('تم تحديث كلمة المرور بنجاح.', 'info');
        renderSession(updateResult.data && updateResult.data.user ? { user: updateResult.data.user } : null);
      } else {
        var loginResult = await supabaseClient.auth.signInWithPassword({ email: email, password: password });
        if (loginResult.error) throw loginResult.error;
        setStatus('تم تسجيل الدخول بنجاح.', 'info');
        renderSession(loginResult.data && loginResult.data.session ? loginResult.data.session : null);
      }
    } catch (error) {
      setStatus(friendlyError(error), 'error');
    } finally {
      updateBusyState(false);
    }
  }

  async function handleForgotPassword() {
    if (busy) return;
    if (!supabaseClient || !supabaseClient.auth) {
      setStatus('نظام الحسابات لم يكتمل تحميله بعد.', 'error');
      return;
    }

    var emailInput = byId('buildlab-account-email');
    var email = emailInput ? emailInput.value.trim() : '';
    if (!email) {
      setStatus('اكتب بريدك الإلكتروني أولًا، ثم اضغط «نسيت كلمة المرور؟».', 'error');
      if (emailInput) emailInput.focus();
      return;
    }

    updateBusyState(true);
    setStatus('جارٍ إرسال رابط استعادة كلمة المرور…', 'info');
    try {
      var result = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + '/'
      });
      if (result.error) throw result.error;
      setStatus('لو البريد مسجل، هتوصلك رسالة فيها رابط آمن لتعيين كلمة مرور جديدة. راجع صندوق الوارد والرسائل غير المرغوب فيها.', 'info');
    } catch (error) {
      setStatus(friendlyError(error), 'error');
    } finally {
      updateBusyState(false);
    }
  }

  async function handleLogout() {
    if (busy || !supabaseClient) return;
    updateBusyState(true);
    setStatus('جارٍ تسجيل الخروج…', 'info');
    try {
      var result = await supabaseClient.auth.signOut();
      if (result.error) throw result.error;
      recoverySession = false;
      setMode('login');
      renderSession(null);
      setStatus('تم تسجيل الخروج.', 'info');
    } catch (error) {
      setStatus(friendlyError(error), 'error');
    } finally {
      updateBusyState(false);
    }
  }

  function attachSupabaseClient(client) {
    if (!client || !client.auth || supabaseClient === client) return;

    supabaseClient = client;
    setStatus('تم الاتصال بنظام الحسابات. جارٍ التحقق من جلستك…', 'info');

    supabaseClient.auth.getSession().then(function (result) {
      if (result.error) throw result.error;
      renderSession(result.data ? result.data.session : null);
      if (!result.data || !result.data.session) setStatus('', 'info');
    }).catch(function (error) {
      setStatus(friendlyError(error), 'error');
    });

    var subscriptionResult = supabaseClient.auth.onAuthStateChange(function (event, session) {
      if (event === 'PASSWORD_RECOVERY') {
        setMode('recovery');
        renderSession(session);
        setStatus('اكتب كلمة مرور جديدة لا تقل عن 8 أحرف.', 'info');
        return;
      }

      if (event === 'SIGNED_OUT') {
        recoverySession = false;
        setMode('login');
      }

      renderSession(session);
    });

    authSubscription = subscriptionResult && subscriptionResult.data
      ? subscriptionResult.data.subscription
      : null;
  }

  function start() {
    panel = document.querySelector(PANEL_SELECTOR);
    if (!panel) {
      console.error('[BuildLab auth] لم يتم العثور على .auth-preview داخل صفحة الحساب.');
      return;
    }

    renderPanel();
    setStatus('جارٍ تهيئة نظام الحسابات…', 'info');

    window.addEventListener('buildlab:supabase-ready', function () {
      attachSupabaseClient(window.BuildLabSupabase);
    });

    // Handles the case where the main app initialized Supabase before this file loaded.
    if (window.BuildLabSupabase) {
      attachSupabaseClient(window.BuildLabSupabase);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // Keep a clean listener lifecycle if this script is ever initialized again by a partial reload.
  window.addEventListener('pagehide', function () {
    if (authSubscription && typeof authSubscription.unsubscribe === 'function') {
      authSubscription.unsubscribe();
      authSubscription = null;
    }
  }, { once: true });
})();
