import slotsSource from "../site/photo-slots.js.txt?raw";
import { marketingAliases, normalizeMarketingPath } from "./marketing-paths";

const raw = import.meta.glob<string>("../site/*.html", {
  query: "?raw",
  import: "default",
  eager: true,
});

const slots = JSON.parse(
  slotsSource.slice(slotsSource.indexOf("{"), slotsSource.lastIndexOf("}") + 1),
) as Record<string, Record<string, { src: string }>>;

const pages = new Map<string, string>();
for (const [file, html] of Object.entries(raw)) {
  const name = file
    .split("/")
    .pop()!
    .replace(/\.html$/, "");
  const path = name === "index" ? "/" : "/" + name.replace(/__/g, "/");
  const images = new Set(Object.values(slots[path] ?? {}).map(({ src }) => src));
  if (path === "/") images.add("/assets/media/pingapp-floral-robot.jpg");
  const extras =
    "<style>[data-framer-appear-id]{opacity:1!important;transform:none!important;filter:none!important}</style>" +
    [...images].map((src) => `<link rel="preload" as="image" href="${src}">`).join("");
  pages.set(
    path,
    html.replace(/<head([^>]*)>/i, (head) => head + extras).replace(/ loading="lazy"/g, ""),
  );
}

export function sitePageResponse(url: URL): Response | undefined {
  const path = normalizeMarketingPath(url.pathname);
  if (Object.hasOwn(marketingAliases, path)) {
    return new Response(null, {
      status: 308,
      headers: { location: marketingAliases[path] + url.search },
    });
  }
  const html = pages.get(path);
  if (html === undefined) return undefined;
  // The export's preview host must not leak into share cards on this installation.
  const document = html.replaceAll("https://pingapp-connect.sleroy1312.chatgpt.site", url.origin);
  return new Response(document, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
