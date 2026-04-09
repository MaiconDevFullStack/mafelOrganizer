'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Conversation extends Model {
    static associate(models) {
      Conversation.hasMany(models.Appointment, { foreignKey: 'conversation_id', as: 'appointments' });
      Conversation.belongsTo(models.Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
      Conversation.hasMany(models.Message, { foreignKey: 'conversation_id', as: 'messages' });
    }
  }

  Conversation.init(
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
      client_name: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      client_email: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      channel: {
        type: DataTypes.ENUM('web', 'whatsapp', 'email', 'app'),
        defaultValue: 'web',
      },
      status: {
        type: DataTypes.ENUM('open', 'escalated', 'closed'),
        defaultValue: 'open',
      },
      session_data: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
    },
    {
      sequelize,
      modelName: 'Conversation',
      tableName: 'conversations',
    }
  );

  return Conversation;
};
