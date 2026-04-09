const newsList = document.getElementById("news-list");
const authOverlay = document.getElementById("auth-overlay");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const logoutBtn = document.getElementById("logout-btn");
const loginUserInput = document.getElementById("login-username");
const googleSignin = document.getElementById("google-signin");

if (
  !newsList ||
  !authOverlay ||
  !loginForm ||
  !loginError ||
  !logoutBtn ||
  !loginUserInput ||
  !googleSignin
) {
  // Splash-only page requested.
  // Do nothing when the news container is intentionally removed.
} else {
  function setAuthUI(isAuthenticated) {
    authOverlay.classList.toggle("hidden", isAuthenticated);
    logoutBtn.classList.toggle("hidden", !isAuthenticated);
    document.body.classList.toggle("locked", !isAuthenticated);

    if (!isAuthenticated) {
      loginUserInput.focus();
    }
  }

  function setLoginError(message) {
    if (!message) {
      loginError.textContent = "";
      loginError.classList.add("hidden");
      return;
    }

    loginError.textContent = message;
    loginError.classList.remove("hidden");
  }

  function onAuthSuccess() {
    setAuthUI(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
    loadNews();
  }

  function formatPublished(dateString) {
    if (!dateString) return "Latest update";
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "Latest update";
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function renderLoading() {
    newsList.innerHTML = '<p class="status">Loading your briefings...</p>';
  }

  function renderError(message) {
    newsList.innerHTML = `<p class="status error">${message}</p>`;
  }

  function createNewsCard(item) {
    const card = document.createElement("article");
    card.className = "card";

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `Updated ${formatPublished(item.published)}`;

    const headline = document.createElement("h2");
    headline.textContent = item.headline;

    const subheading = document.createElement("p");
    subheading.className = "subheading";
    subheading.textContent = item.subheading;

    const actions = document.createElement("div");
    actions.className = "actions";

    const toggleButton = document.createElement("button");
    toggleButton.className = "toggle-btn";
    toggleButton.type = "button";
    toggleButton.textContent = "Article";

    const details = document.createElement("p");
    details.className = "details hidden";
    details.textContent = item.paraphrased;

    toggleButton.addEventListener("click", () => {
      const isHidden = details.classList.contains("hidden");
      details.classList.toggle("hidden");
      toggleButton.textContent = isHidden ? "Hide summary" : "Article";
    });

    actions.append(toggleButton);
    card.append(meta, headline, subheading, actions, details);

    return card;
  }

  function renderNews(items) {
    newsList.innerHTML = "";
    items.forEach((item) => newsList.appendChild(createNewsCard(item)));
  }

  async function loadNews() {
    renderLoading();
    try {
      const response = await fetch("/api/news?limit=60");
      const data = await response.json();

      if (!response.ok || !Array.isArray(data.items)) {
        throw new Error(data.error || "Failed to load news.");
      }

      renderNews(data.items);
    } catch (error) {
      if (error.message.toLowerCase().includes("sign in")) {
        setAuthUI(false);
      }
      renderError(`Could not load news: ${error.message}`);
    }
  }

  async function checkSession() {
    try {
      const response = await fetch("/api/session");
      const data = await response.json();
      return Boolean(response.ok && data.authenticated);
    } catch (error) {
      return false;
    }
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setLoginError("");

    const formData = new FormData(loginForm);
    const username = String(formData.get("username") || "").trim();
    const password = String(formData.get("password") || "");

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Sign in failed.");
      }
      loginForm.reset();
      onAuthSuccess();
    } catch (error) {
      setLoginError(error.message);
    }
  });

  logoutBtn.addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    newsList.innerHTML = "";
    setAuthUI(false);
  });

  checkSession().then((authenticated) => {
    setAuthUI(authenticated);
    if (authenticated) {
      loadNews();
    }
  });

  async function initGoogleSignIn() {
    try {
      const configRes = await fetch("/api/config");
      const config = await configRes.json();
      const clientId = config.googleClientId;
      if (!clientId || !window.google?.accounts?.id) {
        return;
      }

      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async (response) => {
          try {
            const loginRes = await fetch("/api/login/google", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ credential: response.credential }),
            });
            const data = await loginRes.json();
            if (!loginRes.ok) {
              throw new Error(data.error || "Google sign-in failed.");
            }
            setLoginError("");
            onAuthSuccess();
          } catch (error) {
            setLoginError(error.message);
          }
        },
      });

      window.google.accounts.id.renderButton(googleSignin, {
        theme: "outline",
        size: "large",
        shape: "pill",
        text: "signin_with",
        width: 320,
      });
    } catch (error) {
      setLoginError("Google sign-in is currently unavailable.");
    }
  }

  initGoogleSignIn();
}
