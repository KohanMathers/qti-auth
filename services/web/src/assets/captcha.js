async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function solveAltcha(challenge) {
  for (let number = 0; number <= challenge.maxnumber; number++) {
    if ((await sha256Hex(`${challenge.salt}${number}`)) === challenge.challenge) {
      return JSON.stringify({ ...challenge, number });
    }
  }
  throw new Error('No solution found for the CAPTCHA challenge');
}

export async function solveCaptcha(container, t, problem) {
  container.replaceChildren();
  if (problem.provider !== 'altcha' || problem.challenge === undefined) {
    const message = document.createElement('p');
    message.className = 'qtiauth-alert';
    message.setAttribute('role', 'alert');
    message.textContent = t(
      'captcha.unsupported',
      'This page cannot show the CAPTCHA this sign-in method needs. Try again later.',
    );
    container.appendChild(message);
    throw new Error(`Unsupported CAPTCHA provider: ${problem.provider}`);
  }
  const status = document.createElement('p');
  status.className = 'qt-help';
  status.setAttribute('role', 'status');
  status.textContent = t('captcha.verifying', 'Verifying you’re not a robot…');
  container.appendChild(status);
  const token = await solveAltcha(problem.challenge);
  status.textContent = t('captcha.verified', 'Verified.');
  return token;
}
