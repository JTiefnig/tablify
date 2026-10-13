// Small toolbar that appears when hovering a row's baseline cell: add a row
// above or below, delete the row.

export type RowAction = "addAbove" | "addBelow" | "delete";

const ICONS: Record<RowAction, { title: string; svg: string }> = {
  addAbove: {
    title: "Add row above",
    svg: '<path d="M2.5 13.5h11" /><path d="M8 2.5v7M4.5 6h7" />',
  },
  addBelow: {
    title: "Add row below",
    svg: '<path d="M2.5 2.5h11" /><path d="M8 6.5v7M4.5 10h7" />',
  },
  delete: {
    title: "Delete row (undo with Ctrl/Cmd+Z)",
    svg: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />',
  },
};

export const GRIP_ICON =
  '<svg class="row-grip" viewBox="0 0 6 12" aria-hidden="true"><circle cx="1.5" cy="2" r="1"/><circle cx="4.5" cy="2" r="1"/><circle cx="1.5" cy="6" r="1"/><circle cx="4.5" cy="6" r="1"/><circle cx="1.5" cy="10" r="1"/><circle cx="4.5" cy="10" r="1"/></svg>';

const HIDE_DELAY_MS = 180;

export class RowActions {
  private readonly element: HTMLElement;
  private readonly onAction: (action: RowAction, index: number) => void;
  private index: number | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  /** No toolbar while a row is being dragged. */
  private suspended = false;

  constructor(onAction: (action: RowAction, index: number) => void) {
    this.onAction = onAction;
    this.element = document.createElement("div");
    this.element.className = "row-actions";
    this.element.setAttribute("role", "toolbar");
    this.element.setAttribute("aria-label", "Row actions");
    this.element.hidden = true;

    for (const [action, { title, svg }] of Object.entries(ICONS) as [RowAction, (typeof ICONS)[RowAction]][]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `row-action ${action}`;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${svg}</svg>`;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        if (this.index !== null) this.onAction(action, this.index);
        this.hide();
      });
      this.element.appendChild(button);
    }

    this.element.addEventListener("mouseenter", () => clearTimeout(this.hideTimer));
    this.element.addEventListener("mouseleave", () => this.scheduleHide());
    document.body.appendChild(this.element);
  }

  /** Shows the toolbar next to a row's baseline cell. */
  show(cell: HTMLElement, index: number) {
    if (this.suspended) return;
    clearTimeout(this.hideTimer);
    this.index = index;
    this.element.hidden = false;
    const rect = cell.getBoundingClientRect();
    const height = this.element.offsetHeight;
    const top = rect.top + Math.min(rect.height, 32) / 2 - height / 2;
    this.element.style.left = `${rect.right + 2}px`;
    this.element.style.top = `${Math.max(2, Math.min(top, window.innerHeight - height - 2))}px`;
  }

  /** Hides the toolbar until the mouse button is released (drag & drop). */
  suspend() {
    this.hide();
    this.suspended = true;
    document.addEventListener("mouseup", () => (this.suspended = false), { once: true });
  }

  scheduleHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), HIDE_DELAY_MS);
  }

  hide() {
    clearTimeout(this.hideTimer);
    this.element.hidden = true;
    this.index = null;
  }
}
