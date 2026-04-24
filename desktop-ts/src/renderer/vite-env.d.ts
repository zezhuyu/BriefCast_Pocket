/// <reference types="vite/client" />

import { RendererBridge } from "../shared/types";

declare global {
  interface Window {
    briefcast?: RendererBridge;
  }
}

export {};
