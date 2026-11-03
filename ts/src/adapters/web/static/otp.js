// Draws the sign-in code into six boxes. The real field is one ordinary
// input sitting invisibly on top, so typing, pasting, the phone's number
// pad and "fill code from Messages" all work as usual; this only mirrors
// its digits into the boxes. Without JavaScript the plain field shows.
(() => {
  const box = document.querySelector("[data-otp]");
  if (!box) return;
  const input = box.querySelector("input");
  const cells = box.querySelectorAll(".otp-cells span");
  const paint = () => {
    const digits = input.value.replace(/\D/g, "").slice(0, cells.length);
    if (input.value !== digits) input.value = digits;
    const focused = document.activeElement === input;
    cells.forEach((cell, i) => {
      cell.textContent = digits[i] || "";
      cell.classList.toggle("filled", i < digits.length);
      cell.classList.toggle("active", focused && i === Math.min(digits.length, cells.length - 1));
    });
  };
  input.maxLength = cells.length;
  box.classList.add("on");
  for (const event of ["input", "focus", "blur"]) input.addEventListener(event, paint);
  paint();
})();
