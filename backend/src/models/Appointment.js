'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Appointment extends Model {
    static associate(models) {
      Appointment.belongsTo(models.Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
      Appointment.belongsTo(models.Conversation, {
        foreignKey: 'conversation_id',
        as: 'conversation',
      });
    }
  }

  Appointment.init(
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
      conversation_id: {
        type: DataTypes.UUID,
        allowNull: true,
        comment: 'Conversa do chat que originou o agendamento',
      },
      client_name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      client_phone: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: 'Telefone do cliente no formato E.164 ou dígitos',
      },
      service_name: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Nome do serviço extraído da base de conhecimento',
      },
      scheduled_at: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: 'Data e hora do agendamento',
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('pending', 'confirmed', 'cancelled'),
        defaultValue: 'confirmed',
      },
      notified_provider: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: 'true após envio de WhatsApp ao prestador',
      },
    },
    {
      sequelize,
      modelName: 'Appointment',
      tableName: 'appointments',
      underscored: true,
      timestamps: true,
      paranoid: true,
    }
  );

  return Appointment;
};
