# SupplyDesk Hostinger Setup

## What is already in GitHub

- Node.js + Express backend in `server.js`
- MySQL schema in `database/hostinger.sql`
- Supplier registration uploads
- Private document/photo storage
- Admin verification panel at `/admin.html`
- Public verified supplier API and search integration
- `.env.example` for Hostinger environment variables

## 1. Create the MySQL database

In Hostinger:

Websites → Dashboard → Databases → Management → Create a new MySQL database.

Save the exact:
- database name
- username
- password
- database host

Open phpMyAdmin and import **database/hostinger.sql** into the newly created database.

Do not import **database/schema.sql** on Hostinger because that file contains a CREATE DATABASE statement intended for local setup.

## 2. Deploy the Node.js app

In Hostinger:

Websites → Add Website → Deploy Web App → Import Git Repository.

Repository:
`vikas07gill-design/supplydesk`

Branch:
`main`

Framework:
`Express.js` if detected. Otherwise choose `Other`.

Entry file:
`server.js`

Node:
`20.x` or newer supported by the current Hostinger deployment options.

Build command:
`npm install`

The app does not need a frontend build step.

## 3. Add environment variables

Add these in the Hostinger Node.js app environment settings:

`NODE_ENV=production`

`PORT=3000`

`DB_HOST=<Hostinger database host>`

`DB_PORT=3306`

`DB_NAME=<Hostinger database name>`

`DB_USER=<Hostinger database user>`

`DB_PASSWORD=<database password>`

`UPLOAD_DIR=<private absolute directory outside the public web root>`

`ADMIN_TOKEN=<long random secret, minimum 20 characters>`

`PUBLIC_ORIGIN=https://supplydesk.in`

Never put DB passwords or ADMIN_TOKEN in HTML or JavaScript.

## 4. Private uploads

Create a private directory for supplier documents and photos. It must not be directly accessible through the public website.

Example:

`/home/USERNAME/private/supplydesk-uploads`

The Node.js app writes each application into its own UUID folder.

## 5. Test after deployment

Open:

`https://supplydesk.in/api/health`

Expected:

`{"ok":true,"database":"connected"}`

Then open:

`https://supplydesk.in/supplier-register.html`

Submit a test supplier with a test PDF/photo.

Then open:

`https://supplydesk.in/admin.html`

Enter the ADMIN_TOKEN and review the application.

Approve it. The supplier will then be available through the public supplier API and search.

## 6. Important security rule

Do not make the upload directory public.

Legal registration documents, tax documents and address proof must remain admin-only. Only approved supplier profile information should appear in public search.

## 7. Future modules

After this foundation is working, build in this order:

1. Supplier login/dashboard
2. Admin category management
3. Supplier products/services
4. Public supplier/product/service profiles
5. Search improvements
6. Email notifications
7. Verification audit trail
