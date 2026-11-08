export type ReorderEvent = {
  item: HTMLElement;
  from: HTMLElement;
  to: HTMLElement;
  newDraggableIndex?: number;
  originalEvent?: unknown;
};
