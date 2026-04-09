'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Subscription extends Model {
    static associate(models) {
      Subscription.belongsTo(models.Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
    }

    get isActive() {
      return this.status === 'active' && new Date(this.expires_at) > new Date();
    }
  }

  Subscription.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      plan: {
        type: DataTypes.ENUM('monthly', 'annual'),
        allowNull: false,
        defaultValue: 'monthly',
      },
      amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      status: {
        // pending  → aguardando pagamento
        // active   → pago e ativo
        // expired  → expirou sem renovação
        // cancelled → cancelado manualmente
        type: DataTypes.ENUM('pending', 'active', 'expired', 'cancelled'),
        defaultValue: 'pending',
      },
      // IDs do Mercado Pago
      mp_payment_id: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      mp_status: {
        type: DataTypes.STRING,  // pending, approved, rejected, cancelled
        allowNull: true,
      },
      // QR Code PIX
      pix_code: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      pix_qr_base64: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      pix_expires_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // Controle de período
      starts_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      expires_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'Subscription',
      tableName: 'subscriptions',
    }
  );

  return Subscription;
};
