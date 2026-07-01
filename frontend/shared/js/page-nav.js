// 左下角调试标识：半透明小字，标注当前页面所属部分，仅供开发调试定位。
async function initDebugTag(pathLabel) {
  if (document.querySelector(".debug-tag")) return;
  const tag = document.createElement("div");
  tag.className = "debug-tag";
  tag.textContent = pathLabel;
  document.body.appendChild(tag);
}
