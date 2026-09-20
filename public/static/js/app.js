(() => {
  const $ = (sel) => document.querySelector(sel);
  function detectBase() {
    const fromBody = (document.body.getAttribute("data-base") || "").replace(/\/$/, "");
    if (fromBody) return fromBody;
    const baseEl = document.querySelector("base");
    if (baseEl && baseEl.href) {
      try {
        const u = new URL(baseEl.href);
        return (u.pathname || "").replace(/\/$/, "");
      } catch (e) {}
    }
    // اگر صفحه روی /azurequiz یا /azurequiz/ باشد
    const p = window.location.pathname || "";
    if (p.startsWith("/azurequiz")) return "/azurequiz";
    return "";
  }
  const BASE = detectBase();
  const apiUrl = (path) => BASE + path;

  const screens = {
    login: $("#screen-login"),
    home: $("#screen-home"),
    quiz: $("#screen-quiz"),
    result: $("#screen-result"),
    admin: $("#screen-admin"),
  };

  let state = {
    member: null,
    quizToken: null,
    questions: [],
    current: 0,
    total: 0,
    lesson: "",
    waitingNext: false,
  };

  function show(name) {
    Object.values(screens).forEach((el) => el.classList.add("hidden"));
    screens[name].classList.remove("hidden");
    $("#btn-logout").classList.toggle("hidden", name === "login" || !state.member);
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    setTimeout(() => t.classList.add("hidden"), 2800);
  }

  function guideKey(nid) {
    return `azure_quiz_guide_seen_${nid}`;
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
    if (!isForm && opts.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(path, {
      credentials: "same-origin",
      ...opts,
      headers,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : { ok: false, error: "پاسخ خالی از سرور" };
    } catch (_) {
      data = { ok: false, error: `پاسخ نامعتبر از سرور (HTTP ${res.status})` };
    }
    if (res.status === 401) {
      state.member = null;
      show("login");
    }
    return data;
  }

  function downloadUrl(path) {
    window.location.href = apiUrl(path);
  }

  async function refreshMe() {
    const data = await api(apiUrl("/api/me"));
    if (data.logged_in) {
      state.member = data.member;
      await openHome();
    } else show("login");
  }

  function showGuideIfNeeded() {
    const guide = $("#welcome-guide");
    const nid = state.member?.national_id;
    if (!nid) return guide.classList.add("hidden");
    if (localStorage.getItem(guideKey(nid))) guide.classList.add("hidden");
    else guide.classList.remove("hidden");
  }

  async function loadMyHistory() {
    const data = await api(apiUrl("/api/my/history"));
    const box = $("#my-history");
    if (!data.ok || !data.history?.length) {
      box.innerHTML = '<p class="muted" style="padding:10px;margin:0">هنوز آزمونی ثبت نشده است.</p>';
      return;
    }
    const rows = data.history
      .map(
        (r) => `<tr>
        <td>${r.lesson}</td>
        <td>${r.percent}%</td>
        <td>${r.correct}/${Number(r.correct) + Number(r.wrong)}</td>
        <td>${r.datetime}</td>
      </tr>`
      )
      .join("");
    box.innerHTML = `<table><thead><tr><th>درس</th><th>درصد</th><th>صحیح</th><th>زمان شروع</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  async function openHome() {
    const m = state.member;
    $("#welcome").textContent = `سلام ${m.first_name} ${m.last_name}`;
    $("#btn-admin").classList.toggle("hidden", !m.is_admin);
    showGuideIfNeeded();
    const data = await api(apiUrl("/api/lessons"));
    const list = $("#lesson-list");
    list.innerHTML = "";
    if (!data.ok || !data.lessons.length) {
      list.innerHTML = '<p class="muted">درسی یافت نشد.</p>';
    } else {
      data.lessons.forEach((lesson) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "item";
        btn.textContent = lesson;
        btn.onclick = () => startQuiz(lesson);
        list.appendChild(btn);
      });
    }
    await loadMyHistory();
    show("home");
  }

  async function startQuiz(lesson) {
    const data = await api(apiUrl("/api/quiz/start"), {
      method: "POST",
      body: JSON.stringify({ lesson }),
    });
    if (!data.ok) {
      toast(data.error || "خطا در شروع آزمون");
      return;
    }
    state.quizToken = data.token;
    state.questions = data.questions;
    state.total = data.total;
    state.lesson = data.lesson;
    state.current = 0;
    state.waitingNext = false;
    $("#quiz-lesson").textContent = data.lesson;
    renderQuestion();
    show("quiz");
  }

  function renderQuestion() {
    const q = state.questions[state.current];
    $("#quiz-progress").textContent = `${state.current + 1} / ${state.total}`;
    $("#quiz-question").textContent = q.question;
    const box = $("#quiz-options");
    box.innerHTML = "";
    $("#quiz-feedback").classList.add("hidden");
    $("#btn-next").classList.add("hidden");
    state.waitingNext = false;
    q.options.forEach((text, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = `${i + 1}. ${text}`;
      btn.onclick = () => answer(i + 1, btn);
      box.appendChild(btn);
    });
  }

  async function answer(choice, btnEl) {
    if (state.waitingNext) return;
    state.waitingNext = true;
    const data = await api(apiUrl("/api/quiz/answer"), {
      method: "POST",
      body: JSON.stringify({ token: state.quizToken, index: state.current, choice }),
    });
    const opts = [...$("#quiz-options").querySelectorAll("button")];
    opts.forEach((b) => (b.disabled = true));
    const fb = $("#quiz-feedback");
    fb.classList.remove("hidden", "ok", "bad");
    if (data.ok && data.correct) {
      btnEl.classList.add("correct");
      fb.classList.add("ok");
      fb.textContent = data.message || "✅ درست!";
    } else {
      btnEl.classList.add("wrong");
      const correctIdx = (data.correct_choice || 0) - 1;
      if (correctIdx >= 0 && opts[correctIdx]) opts[correctIdx].classList.add("correct");
      fb.classList.add("bad");
      fb.textContent =
        data.message ||
        (data.correct_text ? `❌ نادرست — پاسخ صحیح: ${data.correct_text}` : "❌ نادرست");
    }
    const next = $("#btn-next");
    next.classList.remove("hidden");
    next.textContent = state.current + 1 >= state.total ? "مشاهده نتیجه" : "سؤال بعدی";
  }

  async function goNext() {
    if (state.current + 1 >= state.total) {
      const data = await api(apiUrl("/api/quiz/finish"), {
        method: "POST",
        body: JSON.stringify({ token: state.quizToken }),
      });
      if (!data.ok) {
        toast(data.error || "خطا در ثبت نتیجه");
        return;
      }
      $("#result-score").textContent = `${data.percent}%`;
      $("#result-detail").textContent = `درس: ${data.lesson} — صحیح: ${data.correct} از ${data.total} — غلط: ${data.wrong}`;
      show("result");
      return;
    }
    state.current += 1;
    renderQuestion();
  }

  function setMemberFormMode(editMember) {
    const cancel = $("#btn-cancel-member-edit");
    const btn = $("#btn-add-member");
    if (editMember) {
      $("#member-edit-id").value = editMember.national_id;
      $("#admin-nid").value = editMember.national_id;
      $("#admin-first").value = editMember.first_name;
      $("#admin-last").value = editMember.last_name;
      $("#admin-phone").value = editMember.phone || "";
      btn.textContent = "ذخیره تغییرات";
      cancel.classList.remove("hidden");
    } else {
      $("#member-edit-id").value = "";
      $("#admin-nid").value = "";
      $("#admin-first").value = "";
      $("#admin-last").value = "";
      $("#admin-phone").value = "";
      btn.textContent = "ثبت عضو";
      cancel.classList.add("hidden");
    }
  }

  function renderMembersTable(members) {
    const rows = (members || [])
      .map(
        (m) => `<tr>
        <td>${m.national_id}</td>
        <td>${m.first_name}</td>
        <td>${m.last_name}</td>
        <td>${m.phone || ""}</td>
        <td class="actions">
          <button type="button" class="btn tiny secondary" data-edit-member='${JSON.stringify(m).replace(/'/g, "&#39;")}'>ویرایش</button>
          <button type="button" class="btn tiny danger" data-del-member="${m.national_id}">حذف</button>
        </td>
      </tr>`
      )
      .join("");
    $("#admin-members").innerHTML = `<table>
      <thead><tr><th>کد ملی</th><th>نام</th><th>نام خانوادگی</th><th>شماره همراه</th><th>عملیات</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='5'>عضوی ثبت نشده</td></tr>"}</tbody></table>`;
    $("#admin-members").querySelectorAll("[data-edit-member]").forEach((btn) => {
      btn.onclick = () => {
        try {
          setMemberFormMode(JSON.parse(btn.getAttribute("data-edit-member")));
        } catch (_) {}
      };
    });
    $("#admin-members").querySelectorAll("[data-del-member]").forEach((btn) => {
      btn.onclick = async () => {
        const nid = btn.getAttribute("data-del-member");
        if (!confirm(`عضو ${nid} حذف شود؟`)) return;
        const data = await api(apiUrl("/api/admin/members"), {
          method: "DELETE",
          body: JSON.stringify({ national_id: nid }),
        });
        if (!data.ok) return toast(data.error || "حذف ناموفق");
        toast("عضو حذف شد");
        await openAdmin();
      };
    });
  }

  function renderLessonsTable(lessons) {
    const rows = (lessons || [])
      .map(
        (L) => `<tr>
        <td>${L.lesson}</td>
        <td>${L.count}</td>
        <td class="actions">
          <button type="button" class="btn tiny secondary" data-export-lesson="${encodeURIComponent(L.lesson)}">خروجی</button>
          <button type="button" class="btn tiny danger" data-del-lesson="${L.lesson}">حذف</button>
        </td>
      </tr>`
      )
      .join("");
    $("#admin-lessons").innerHTML = `<table>
      <thead><tr><th>درس</th><th>تعداد سؤال</th><th>عملیات</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='3'>درسی نیست</td></tr>"}</tbody></table>`;
    $("#admin-lessons").querySelectorAll("[data-export-lesson]").forEach((btn) => {
      btn.onclick = () => {
        const lesson = decodeURIComponent(btn.getAttribute("data-export-lesson"));
        downloadUrl(`/api/admin/lessons/${encodeURIComponent(lesson)}/export`);
      };
    });
    $("#admin-lessons").querySelectorAll("[data-del-lesson]").forEach((btn) => {
      btn.onclick = async () => {
        const lesson = btn.getAttribute("data-del-lesson");
        if (!confirm(`درس «${lesson}» و تمام سؤالاتش حذف شود؟ (نتایج قدیمی باقی می‌مانند)`)) return;
        const data = await api(apiUrl("/api/admin/lessons"), {
          method: "DELETE",
          body: JSON.stringify({ lesson }),
        });
        if (!data.ok) return toast(data.error || "حذف ناموفق");
        toast("درس حذف شد");
        await openAdmin();
      };
    });
  }

  function renderResultsPanel(report) {
    const filt = $("#results-filter").value;
    const box = $("#admin-results");
    if (filt === "complete") {
      const rows = [];
      (report.complete || []).forEach((m) => {
        (m.results || []).forEach((r) => {
          rows.push(`<tr>
            <td>${m.first_name} ${m.last_name}</td>
            <td>${m.national_id}</td>
            <td>${m.phone || ""}</td>
            <td>${r.lesson}</td>
            <td>${r.percent}%</td>
            <td>${r.datetime}</td>
          </tr>`);
        });
      });
      box.innerHTML = `<table>
        <thead><tr><th>نام</th><th>کد ملی</th><th>موبایل</th><th>درس</th><th>درصد</th><th>زمان شروع</th></tr></thead>
        <tbody>${rows.join("") || "<tr><td colspan='6'>موردی نیست</td></tr>"}</tbody></table>`;
      return;
    }
    if (filt === "incomplete") {
      const rows = (report.incomplete || [])
        .map(
          (m) => `<tr>
          <td>${m.first_name} ${m.last_name}</td>
          <td>${m.national_id}</td>
          <td>${m.phone || ""}</td>
          <td>${(m.missing_lessons || []).join("، ")}</td>
        </tr>`
        )
        .join("");
      box.innerHTML = `<table>
        <thead><tr><th>نام</th><th>کد ملی</th><th>موبایل</th><th>دروس امتحان‌نداده</th></tr></thead>
        <tbody>${rows || "<tr><td colspan='4'>موردی نیست</td></tr>"}</tbody></table>`;
      return;
    }
    const rows = (report.recent_results || [])
      .map(
        (r) => `<tr>
        <td>${r.first_name} ${r.last_name}</td>
        <td>${r.national_id}</td>
        <td>${r.phone || ""}</td>
        <td>${r.lesson}</td>
        <td>${r.percent}%</td>
        <td>${r.datetime}</td>
      </tr>`
      )
      .join("");
    box.innerHTML = `<table>
      <thead><tr><th>نام</th><th>کد ملی</th><th>موبایل</th><th>درس</th><th>درصد</th><th>زمان شروع</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='6'>نتیجه‌ای نیست</td></tr>"}</tbody></table>`;
  }

  let lastReport = null;

  async function openAdmin() {
    const data = await api(apiUrl("/api/admin/stats"));
    if (!data.ok) {
      toast(data.error || "خطای ادمین");
      return;
    }
    $("#admin-stats").innerHTML = `
      <div class="stat"><b>${data.members}</b><span>اعضا</span></div>
      <div class="stat"><b>${data.questions}</b><span>سؤالات</span></div>
      <div class="stat"><b>${(data.lessons_detail || data.lessons || []).length}</b><span>دروس</span></div>
      <div class="stat"><b>${(data.recent_results || []).length}</b><span>نتایج اخیر</span></div>`;
    renderMembersTable(data.members_list || []);
    renderLessonsTable(data.lessons_detail || []);
    setMemberFormMode(null);
    $("#admin-member-msg").classList.add("hidden");
    $("#admin-q-msg").classList.add("hidden");
    const report = await api(apiUrl("/api/admin/results/report?filter=all"));
    lastReport = report;
    if (report.ok) renderResultsPanel(report);
    show("admin");
  }

  async function saveMember() {
    const msg = $("#admin-member-msg");
    msg.classList.add("hidden");
    const editId = $("#member-edit-id").value.trim();
    const payload = {
      national_id: editId || $("#admin-nid").value.trim(),
      new_national_id: $("#admin-nid").value.trim(),
      first_name: $("#admin-first").value.trim(),
      last_name: $("#admin-last").value.trim(),
      phone: $("#admin-phone").value.trim(),
    };
    const data = await api(apiUrl("/api/admin/members"), {
      method: editId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    if (!data.ok) {
      msg.textContent = data.error || "عملیات ناموفق";
      msg.classList.remove("hidden", "success-msg");
      return;
    }
    msg.textContent = editId ? "عضو ویرایش شد" : "عضو اضافه شد";
    msg.classList.add("success-msg");
    msg.classList.remove("hidden");
    toast(msg.textContent);
    await openAdmin();
  }

  async function importMembersFile(file) {
    const msg = $("#admin-member-msg");
    msg.classList.remove("hidden", "success-msg");
    msg.textContent = `در حال بررسی فایل: ${file.name} ...`;
    const fd = new FormData();
    fd.append("file", file);
    const data = await api(apiUrl("/api/admin/members/import"), { method: "POST", body: fd });
    if (!data.ok) {
      msg.textContent = data.error || "Import ناموفق";
      return;
    }
    msg.classList.add("success-msg");
    msg.textContent = `Import انجام شد — کل: ${data.total} | اضافه‌شده: ${data.added} | تکراری: ${data.duplicates} | نامعتبر: ${data.invalid}`;
    if (data.invalid_details?.length) {
      msg.textContent += " | " + data.invalid_details.slice(0, 3).join("؛ ");
    }
    toast("اعضا import شدند");
    await openAdmin();
  }

  async function importQuestionsFile(file) {
    const msg = $("#admin-q-msg");
    msg.classList.remove("hidden", "success-msg");
    msg.textContent = `در حال بررسی فایل: ${file.name} ...`;
    const fd = new FormData();
    fd.append("file", file);
    const data = await api(apiUrl("/api/admin/questions/import"), { method: "POST", body: fd });
    if (!data.ok) {
      msg.textContent = data.error || "Import ناموفق";
      return;
    }
    msg.classList.add("success-msg");
    msg.textContent = `درس «${data.lesson}» — کل: ${data.total} | جدید: ${data.added} | تکراری: ${data.duplicates} | نامعتبر: ${data.invalid}`;
    toast("سؤالات import شدند");
    await openAdmin();
  }

  $("#btn-login").onclick = async () => {
    $("#login-error").classList.add("hidden");
    const data = await api(apiUrl("/api/login"), {
      method: "POST",
      body: JSON.stringify({ national_id: $("#input-nid").value.trim() }),
    });
    if (!data.ok) {
      const e = $("#login-error");
      e.textContent = data.error || "ورود ناموفق";
      e.classList.remove("hidden");
      return;
    }
    state.member = data.member;
    await openHome();
  };
  $("#input-nid").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-login").click();
  });
  $("#btn-logout").onclick = async () => {
    await api(apiUrl("/api/logout"), { method: "POST", body: "{}" });
    state = { member: null, quizToken: null, questions: [], current: 0, total: 0, lesson: "", waitingNext: false };
    show("login");
  };
  $("#btn-dismiss-guide").onclick = () => {
    if (state.member?.national_id) localStorage.setItem(guideKey(state.member.national_id), "1");
    $("#welcome-guide").classList.add("hidden");
  };
  $("#btn-next").onclick = goNext;
  $("#btn-home").onclick = openHome;
  $("#btn-admin").onclick = openAdmin;
  $("#btn-admin-back").onclick = openHome;
  $("#btn-add-member").onclick = saveMember;
  $("#btn-cancel-member-edit").onclick = () => setMemberFormMode(null);
  $("#btn-import-members").onclick = () => $("#file-members").click();
  $("#file-members").onchange = () => {
    const f = $("#file-members").files?.[0];
    if (f) importMembersFile(f);
    $("#file-members").value = "";
  };
  $("#btn-export-members").onclick = () => downloadUrl("/api/admin/members/export");
  $("#btn-import-questions").onclick = () => $("#file-questions").click();
  $("#file-questions").onchange = () => {
    const f = $("#file-questions").files?.[0];
    if (f) importQuestionsFile(f);
    $("#file-questions").value = "";
  };
  $("#results-filter").onchange = () => {
    if (lastReport) renderResultsPanel(lastReport);
  };
  $("#btn-export-complete").onclick = () => downloadUrl("/api/admin/results/export-complete");
  $("#btn-export-incomplete").onclick = () => downloadUrl("/api/admin/results/export-incomplete");

  try {
    if (window.Eitaa && Eitaa.WebApp) {
      Eitaa.WebApp.ready();
      Eitaa.WebApp.expand();
    }
  } catch (_) {}
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(BASE + "/sw.js").catch(() => {});
  }
  refreshMe();
})();
