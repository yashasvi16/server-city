// Boot log shown while the island loads. Every line reports a real step.
export class BootLog {
  private ol = document.getElementById('boot-log')!;
  private fill = document.getElementById('loader-fill') as HTMLElement;
  private el = document.getElementById('loader')!;
  private steps = 0;
  private finished = false;
  constructor(private total: number) {}

  done(what: string, detail: string, kind: 'ok' | 'warn' = 'ok') {
    const li = document.createElement('li');
    li.innerHTML = `<span></span><span class="${kind}"></span>`;
    (li.firstChild as HTMLElement).textContent = what;
    (li.lastChild as HTMLElement).textContent = detail;
    this.ol.appendChild(li);
    this.steps++;
    this.fill.style.width = `${Math.min(100, (this.steps / this.total) * 100)}%`;
  }

  fail(msg: string) {
    this.done('error', msg, 'warn');
  }

  finish(after: () => void) {
    if (this.finished) return;
    this.finished = true;
    this.fill.style.width = '100%';
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => {
      this.el.classList.add('done');
      after();
      setTimeout(() => this.el.remove(), 1000);
    }, reduce ? 50 : 450);
  }
}
