import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
import "./styles.css";

// Pre-warm the brand logos so the AI entry mark never re-decodes (and blinks)
// when switching between the mail list and reader toolbars. Preloading alone
// only fetches the bytes; a freshly mounted <img> still needs a decoded frame.
const warmBrandImages = () => {
  for (const url of ["/nami-logo-light.png", "/nami-logo-dark.png"]) {
    const img = new Image();
    img.src = url;
  }
};
warmBrandImages();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
