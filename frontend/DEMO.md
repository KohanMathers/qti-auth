# Frontend Demo Mode

## Quick Preview (No Backend Needed)

Want to see how it looks without setting up the database? Use demo mode!

### Option 1: Quick Look (current setup)

```bash
npm install
npm run dev
```

Open `http://localhost:3000` - you'll see the login page styled and ready.

---

### Option 2: Full Demo (all pages with mock data)

**Step 1:** Swap to demo mode

```bash
# Backup original
cp src/main.jsx src/main-original.jsx

# Use demo version
cp src/main-demo.jsx src/main.jsx
```

**Step 2:** Run dev server

```bash
npm run dev
```

**Step 3:** Navigate through all pages

Open `http://localhost:3000` and you'll see a navigation bar at the top with links to:

- **Login** - OAuth buttons + email magic link form
- **Claim Username** - Username selection after signup
- **Dashboard (User)** - Regular user profile view
- **Dashboard (Admin)** - Admin view with moderation access
- **Moderation Queue** - Full admin moderation interface

Click around! The UI is fully functional, just without real data.

---

### Option 3: Just Open in Browser (Static HTML)

If you don't want to run npm at all:

```bash
# Build static files
npm install
npm run build

# Open in browser
open dist/index.html
```

(Won't have routing, but you'll see the base UI)

---

### What Works in Demo Mode

✅ All styling and layouts
✅ Form inputs and validation (client-side)
✅ Navigation between pages
✅ Responsive design (try resizing!)
✅ All UI components visible

### What Doesn't Work

❌ Actual login (no backend)
❌ API calls (they'll error in console, ignore it)
❌ Real data (using mock users)

---

### Switching Back to Production Mode

```bash
# Restore original
cp src/main-original.jsx src/main.jsx

# Or just manually edit src/main.jsx to import App instead of AppDemo
```

---

### Quick Screenshot Tour

**Login Page:**
- Gradient purple background
- OAuth buttons (Google, GitHub, Discord)
- Email magic link form
- Age verification field

**Username Claim:**
- Clean input form
- Character count rules
- Validation hints

**Dashboard:**
- User profile info
- Username change form
- Security settings
- Reports tracking

**Moderation Queue (Admin):**
- Pending reports list
- Priority badges (urgent/high/medium/low)
- Report details panel
- Action form (ban/warn/timeout)

---

## Customization

All styling is in `src/App.css` - super easy to customize:

```css
:root {
  --primary: #3b82f6;        /* Change to your brand color */
  --primary-hover: #2563eb;
  --danger: #dc2626;
  /* ... etc */
}
```

No CSS-in-JS nonsense. Just clean, readable CSS variables.

---

Enjoy the preview! 🎨
