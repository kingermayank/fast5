/**
 * Something went wrong that would otherwise leave a silent black screen (a
 * shader that won't compile on this GPU, the GPU dropping the page, a script
 * error): say so on screen, so a player can tell us what it says.
 */
export function reportProblem(text: string): void {
  console.error('Fast5:', text);
  let box = document.getElementById('problem');
  if (!box) {
    box = document.createElement('div');
    box.id = 'problem';
    box.style.cssText =
      'position:fixed;left:12px;right:12px;top:12px;z-index:1000;padding:10px 14px;border-radius:8px;background:rgba(120,16,16,.92);color:#fff;font:13px/1.4 system-ui,sans-serif;white-space:pre-wrap;pointer-events:none';
    document.body.appendChild(box);
  }
  if (box.childElementCount >= 4) return;
  const line = document.createElement('div');
  line.textContent = text;
  box.appendChild(line);
}

/** Report script errors and failed promises too. */
export function watchForProblems(): void {
  window.addEventListener('error', (e) => reportProblem(`Error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => reportProblem(`Error: ${(e.reason as Error)?.message ?? e.reason}`));
}
