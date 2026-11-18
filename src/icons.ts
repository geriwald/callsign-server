import { config } from "./config.ts";

// Shared by the MCP server identity and the server card, so clients show the instance's own icon.
export const serverIcons = () => [
  {
    src: new URL("/icon.svg", config.SITE_URL).toString(),
    mimeType: "image/svg+xml",
    sizes: ["any"],
  },
  {
    src: new URL("/apple-icon.png", config.SITE_URL).toString(),
    mimeType: "image/png",
    sizes: ["180x180"],
  },
];
