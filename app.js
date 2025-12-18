const express = require('express');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
    },
  },
}));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Function to fetch secrets from Google Secret Manager
async function getSecret(secretName) {
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({
    name: `projects/${process.env.GOOGLE_CLOUD_PROJECT}/secrets/${secretName}/versions/latest`,
  });
  return version.payload.data.toString();
}

// Main application logic
(async () => {
  try {
    // Fetch secrets if in production
    if (process.env.NODE_ENV === 'production') {
      console.log('Fetching secrets for production...');
      process.env.DATABASE_URL = await getSecret('DATABASE_URL');
    }

    // Initialize Sequelize
    const sequelize = new Sequelize(process.env.DATABASE_URL, {
      dialect: 'postgres',
      logging: process.env.NODE_ENV === 'development' ? console.log : false,
    });

    // Define Client model
    const Client = sequelize.define('Client', {
      first_name: { type: DataTypes.STRING, allowNull: false },
      last_name: { type: DataTypes.STRING, allowNull: false },
      email: { type: DataTypes.STRING, allowNull: false, unique: true },
      phone: { type: DataTypes.STRING },
      company: { type: DataTypes.STRING },
      address: { type: DataTypes.STRING },
      city: { type: DataTypes.STRING },
      postal_code: { type: DataTypes.STRING },
      country: { type: DataTypes.STRING },
    }, {
      tableName: 'Clients',
      timestamps: true,
    });

    // Test database connection
    await sequelize.authenticate();
    console.log('✓ Database connection established successfully.');

    // Sync models
    await sequelize.sync();

    // Routes

    // Health check endpoint for GCP
    app.get('/_health', async (_req, res) => {
      try {
        await sequelize.authenticate();
        res.status(200).json({
          status: 'ok',
          database: 'connected',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        res.status(503).json({
          status: 'error',
          database: 'disconnected',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Favicon
    app.get('/favicon.ico', (_req, res) => {
      res.status(204).end();
    });

    // Home page
    app.get('/', (req, res) => {
      res.send(`
        <h1>Client Information Database</h1>
        <p>Application is running and connected to the database.</p>
        <a href="/clients.html">View Clients</a>
      `);
    });

    // GET all clients (API)
    app.get('/api/clients', apiLimiter, async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        const { count, rows } = await Client.findAndCountAll({
          offset,
          limit,
          order: [['createdAt', 'DESC']],
        });

        res.json({
          totalRecords: count,
          currentPage: page,
          totalPages: Math.ceil(count / limit),
          clients: rows,
        });
      } catch (error) {
        console.error('Error fetching clients:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });

    // GET single client
    app.get('/api/clients/:id', apiLimiter, async (req, res) => {
      try {
        const client = await Client.findByPk(req.params.id);
        if (!client) {
          return res.status(404).json({ error: 'Client not found' });
        }
        res.json(client);
      } catch (error) {
        console.error('Error fetching client:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });

    // CREATE client (POST)
    app.post('/api/clients', apiLimiter, async (req, res) => {
      try {
        const { first_name, last_name, email, phone, company, address, city, postal_code, country } = req.body;

        const client = await Client.create({
          first_name,
          last_name,
          email,
          phone,
          company,
          address,
          city,
          postal_code,
          country,
        });

        res.status(201).json(client);
      } catch (error) {
        console.error('Error creating client:', error);
        res.status(500).json({ error: 'Failed to create client' });
      }
    });

    // UPDATE client (PUT)
    app.put('/api/clients/:id', apiLimiter, async (req, res) => {
      try {
        const client = await Client.findByPk(req.params.id);
        if (!client) {
          return res.status(404).json({ error: 'Client not found' });
        }

        await client.update(req.body);
        res.json(client);
      } catch (error) {
        console.error('Error updating client:', error);
        res.status(500).json({ error: 'Failed to update client' });
      }
    });

    // DELETE client
    app.delete('/api/clients/:id', apiLimiter, async (req, res) => {
      try {
        const client = await Client.findByPk(req.params.id);
        if (!client) {
          return res.status(404).json({ error: 'Client not found' });
        }

        await client.destroy();
        res.json({ message: 'Client deleted successfully' });
      } catch (error) {
        console.error('Error deleting client:', error);
        res.status(500).json({ error: 'Failed to delete client' });
      }
    });

    // Serve clients.html at /clients
    app.get('/clients', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'clients.html'));
    });

    // Start server
    const server = app.listen(port, () => {
      console.log(`✓ App running at http://localhost:${port}`);
      console.log(`✓ Health check: http://localhost:${port}/_health`);
      console.log(`✓ API: http://localhost:${port}/api/clients`);
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('SIGTERM signal received: closing HTTP server');
      server.close(async () => {
        console.log('HTTP server closed');
        try {
          await sequelize.close();
          console.log('Database connection closed');
          process.exit(0);
        } catch (error) {
          console.error('Error closing database:', error);
          process.exit(1);
        }
      });
    });

  } catch (error) {
    console.error('✗ Failed to initialize application:', error.message);
    process.exit(1);
  }
})();
