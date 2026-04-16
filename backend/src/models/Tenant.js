'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Tenant extends Model {
    static associate(models) {
      Tenant.hasMany(models.User, { foreignKey: 'tenant_id', as: 'users' });
      Tenant.hasMany(models.Conversation, { foreignKey: 'tenant_id', as: 'conversations' });
      Tenant.hasMany(models.PaymentSchedule, { foreignKey: 'tenant_id', as: 'paymentSchedules' });
      Tenant.hasMany(models.Subscription, { foreignKey: 'tenant_id', as: 'subscriptions' });
      Tenant.hasMany(models.Appointment, { foreignKey: 'tenant_id', as: 'appointments' });
      Tenant.hasMany(models.ServiceSlot, { foreignKey: 'tenant_id', as: 'serviceSlots' });
    }
  }

  Tenant.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      slug: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
      },
      plan: {
        type: DataTypes.ENUM('basic', 'professional', 'enterprise'),
        defaultValue: 'basic',
      },
      // Customização visual do agente
      agent_name: {
        type: DataTypes.STRING,
        defaultValue: 'Assistente',
      },
      background_url: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      primary_color: {
        type: DataTypes.STRING(7),
        defaultValue: '#2563eb',
      },
      logo_url: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      welcome_message: {
        type: DataTypes.TEXT,
        defaultValue: 'Olá! Como posso ajudar?',
      },
      // Slug gerado automaticamente a partir do agent_name — usado na URL /chat/<agent_slug>
      agent_slug: {
        type: DataTypes.STRING(80),
        allowNull: true,
        unique: true,
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      settings: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
    },
    {
      sequelize,
      modelName: 'Tenant',
      tableName: 'tenants',
    }
  );

  return Tenant;
};
