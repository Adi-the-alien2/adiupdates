const newsList = document.getElementById("news-list");

if (!newsList) {
  // Splash-only page requested.
  // Do nothing when the news container is intentionally removed.
} else {
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
    toggleButton.textContent = "See more";

    const sourceLink = document.createElement("a");
    sourceLink.className = "source-link";
    sourceLink.href = item.link;
    sourceLink.target = "_blank";
    sourceLink.rel = "noopener noreferrer";
    sourceLink.textContent = "Article";

    const details = document.createElement("p");
    details.className = "details hidden";
    details.textContent = item.paraphrased;

    toggleButton.addEventListener("click", () => {
      const isHidden = details.classList.contains("hidden");
      details.classList.toggle("hidden");
      toggleButton.textContent = isHidden ? "Hide" : "See more";
    });

    actions.append(toggleButton, sourceLink);
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
      renderError(`Could not load news: ${error.message}`);
    }
  }

  loadNews();
}
