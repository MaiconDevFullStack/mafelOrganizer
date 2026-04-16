'use strict';
const { Model } = require('sequelize');

/**
 * ServiceSlot — horários de atendimento cadastrados pelo prestador.
 *
 * Cada registro representa um slot recorrente semanal (day_of_week + start_time)
 * com duração configurável. O fluxo de agendamento consulta esta tabela para
 * gerar a lista numerada de horários disponíveis apresentada ao cliente.
 */
module.exports = (sequelize, DataTypes) => {
  class ServiceSlot extends Model {
    static associate(models) {
      ServiceSlot.belongsTo(models.Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
    }
  }

  ServiceSlot.init(
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
      // 0=Dom, 1=Seg, 2=Ter, 3=Qua, 4=Qui, 5=Sex, 6=Sáb
      day_of_week: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: { min: 0, max: 6 },
        comment: '0=Dom 1=Seg 2=Ter 3=Qua 4=Qui 5=Sex 6=Sáb',
      },
      // Formato HH:MM, ex: "09:00"
      start_time: {
        type: DataTypes.STRING(5),
        allowNull: false,
        comment: 'Horário de início no formato HH:MM',
      },
      duration_minutes: {
        type: DataTypes.INTEGER,
        defaultValue: 60,
        comment: 'Duração do atendimento em minutos',
      },
      service_name: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Nome do serviço oferecido neste slot (opcional)',
      },
      max_bookings: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        comment: 'Quantidade máxima de agendamentos simultâneos',
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
    },
    {
      sequelize,
      modelName: 'ServiceSlot',
      tableName: 'service_slots',
    }
  );

  return ServiceSlot;
};
