#!/bin/bash
# QTI Auth - Quick Setup Script
# Run this after cloning the repo

set -e

echo "🚀 QTI Auth System - Quick Setup"
echo "================================"
echo ""

# Check prerequisites
echo "📋 Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 18+ first."
    exit 1
fi

if ! command -v wrangler &> /dev/null; then
    echo "⚠️  Wrangler not found. Installing globally..."
    npm install -g wrangler
fi

echo "✅ Prerequisites OK"
echo ""

# Install worker dependencies
echo "📦 Installing worker dependencies..."
npm install
echo "✅ Worker dependencies installed"
echo ""

# Install frontend dependencies
echo "📦 Installing frontend dependencies..."
cd frontend
npm install
cd ..
echo "✅ Frontend dependencies installed"
echo ""

# Create D1 database
echo "🗄️  Creating D1 database..."
echo "Please follow these steps:"
echo ""
echo "1. Run: wrangler d1 create qti_auth"
echo "2. Copy the database ID from the output"
echo "3. Paste it into wrangler.toml (replace YOUR_DATABASE_ID_HERE)"
echo "4. Then run: wrangler d1 execute qti_auth --file=./schema.sql"
echo ""
read -p "Press Enter when you've completed these steps..."
echo ""

# Set secrets
echo "🔐 Setting up secrets..."
echo ""
echo "You'll need to set these secrets. Generate secure values:"
echo ""

# JWT Secret
echo "Setting JWT_SECRET..."
echo "Generate with: openssl rand -base64 32"
JWT_SECRET=$(openssl rand -base64 32)
echo "Generated JWT_SECRET: $JWT_SECRET"
echo "$JWT_SECRET" | wrangler secret put JWT_SECRET
echo "✅ JWT_SECRET set"
echo ""

# Optional OAuth secrets
echo "⚠️  OAuth secrets are optional. Set them later if you want OAuth login."
echo "To set OAuth secrets, run:"
echo "  wrangler secret put GOOGLE_CLIENT_ID"
echo "  wrangler secret put GOOGLE_CLIENT_SECRET"
echo "  (same for GITHUB and DISCORD)"
echo ""

# Email service
echo "📧 Email service setup (required for magic links)"
echo "You'll need an email service API key (SendGrid, Resend, etc.)"
read -p "Do you want to set EMAIL_SERVICE_API_KEY now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    wrangler secret put EMAIL_SERVICE_API_KEY
    echo "✅ EMAIL_SERVICE_API_KEY set"
else
    echo "⚠️  Skipped. Set later with: wrangler secret put EMAIL_SERVICE_API_KEY"
fi
echo ""

# Update wrangler.toml
echo "⚙️  Configuring wrangler.toml..."
read -p "Enter your domain (e.g., qti.example): " DOMAIN
sed -i.bak "s/qti.example/$DOMAIN/g" wrangler.toml
sed -i.bak "s/qti.example/$DOMAIN/g" frontend/.env.example
echo "✅ Configuration updated"
echo ""

# Create .env.local for frontend
echo "📝 Creating frontend/.env.local..."
cp frontend/.env.example frontend/.env.local
echo "✅ Frontend environment configured"
echo ""

# Summary
echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Review wrangler.toml and update any remaining config"
echo "2. Deploy worker: wrangler deploy"
echo "3. Build frontend: cd frontend && npm run build"
echo "4. Deploy frontend: wrangler pages deploy dist --project-name=qti-auth-frontend"
echo "5. Create your first admin account (see DEPLOYMENT.md)"
echo "6. Complete compliance checklist (see UK_OSA_COMPLIANCE.md)"
echo ""
echo "📚 Documentation:"
echo "- Full deployment guide: DEPLOYMENT.md"
echo "- Compliance checklist: UK_OSA_COMPLIANCE.md"
echo "- API reference: README.md"
echo ""
echo "🎉 You're ready to deploy!"
