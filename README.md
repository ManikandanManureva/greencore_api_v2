# Greencore API V2

Backend API for Greencore Resources Indonesia - PC Production System

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL (v12 or higher)

## Installation

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables:
```bash
cp .env.example .env
```

Edit `.env` file with your database credentials:
```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=greencorev2
DB_USER=postgres
DB_PASSWORD=your_password
JWT_SECRET=your_secret_key
```

3. Setup database:
```bash
npm run setup-db
```

This will:
- Create the `greencorev2` database if it doesn't exist
- Create necessary tables
- Create a default admin user (Employee ID: OP001, Password: password123)

## Running the Server

Development mode (with auto-reload):
```bash
npm run dev
```

Production mode:
```bash
npm start
```

The server will run on `http://localhost:3000`

## API Endpoints

### Authentication

#### POST /api/auth/login
Login with Employee ID and Password

**Request Body:**
```json
{
  "employeeId": "OP001",
  "password": "password123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "token": "jwt_token_here",
  "user": {
    "id": 1,
    "employeeId": "OP001",
    "name": "Admin User",
    "email": "admin@greencore.com",
    "role": "admin"
  }
}
```

#### GET /api/auth/verify
Verify JWT token

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "user": {
    "id": 1,
    "employeeId": "OP001",
    "name": "Admin User",
    "email": "admin@greencore.com",
    "role": "admin"
  }
}
```

## Database Schema

### Users Table
- `id` (SERIAL PRIMARY KEY)
- `employee_id` (VARCHAR, UNIQUE)
- `password` (VARCHAR, hashed)
- `name` (VARCHAR)
- `email` (VARCHAR)
- `role` (VARCHAR, default: 'employee')
- `is_active` (BOOLEAN, default: true)
- `created_at` (TIMESTAMP)
- `updated_at` (TIMESTAMP)

## Security Notes

- Passwords are hashed using bcrypt
- JWT tokens are used for authentication
- Change default credentials in production
- Use strong JWT_SECRET in production environment
