require('dotenv').config();

// Railway injeta DATABASE_URL automaticamente no plugin PostgreSQL.
// Suportamos tanto DATABASE_URL quanto as variáveis individuais.
const productionConfig = process.env.DATABASE_URL
  ? {
      url: process.env.DATABASE_URL,
      dialect: 'postgres',
      logging: false,
      dialectOptions: {
        ssl: { require: true, rejectUnauthorized: false },
      },
      define: { underscored: true, timestamps: true, paranoid: true },
    }
  : {
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      host:     process.env.DB_HOST,
      port:     parseInt(process.env.DB_PORT || '5432'),
      dialect:  'postgres',
      logging:  false,
      dialectOptions: {
        ssl: process.env.DB_SSL === 'true' ? { require: true, rejectUnauthorized: false } : false,
      },
      define: { underscored: true, timestamps: true, paranoid: true },
    };

module.exports = {
  development: {
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || 'postgres',
    database: process.env.DB_NAME || 'mafel_organizer',
    host:     process.env.DB_HOST || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT || '5432'),
    dialect:  'postgres',
    logging:  false,
    define: {
      underscored: true,
      timestamps:  true,
      paranoid:    true,
    },
  },
  test: {
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: `${process.env.DB_NAME}_test`,
    host:     process.env.DB_HOST,
    dialect:  'postgres',
    logging:  false,
  },
  production: productionConfig,
};
