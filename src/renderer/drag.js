// Drag-to-move via the header bar
const bar = document.getElementById('bar');
const panel = document.getElementById('panel');
let dragging = false;
let startX, startY, startWinX, startWinY;

bar.addEventListener('mousedown', (e) => {
  if (e.target !== bar && e.target.classList.contains('brand') === false && e.target.classList.contains('spacer') === false) return;
  dragging = true;
  startX = e.screenX;
  startY = e.screenY;
  panel.classList.add('dragging');
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.screenX - startX;
  const dy = e.screenY - startY;
  window.glance.moveWindow(dx, dy);
  startX = e.screenX;
  startY = e.screenY;
});

document.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false;
    panel.classList.remove('dragging');
  }
});
