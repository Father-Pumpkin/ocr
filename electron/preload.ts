// Phase 2: nothing exposed to the renderer.
// The renderer reaches the backend via fetch('/api/...') with Vite proxy in dev
// and via window.location.origin in prod. If we later need IPC for things HTTP
// can't do (file dialogs, OS notifications, OAuth deep-links), expose bridges
// here using contextBridge.exposeInMainWorld.
export {};
