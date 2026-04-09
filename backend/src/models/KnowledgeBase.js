'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class KnowledgeBase extends Model {
    static associate(models) {
      KnowledgeBase.belongsTo(models.Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
    }
  }

  KnowledgeBase.init(
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
      original_name: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'Nome original do arquivo enviado pelo usuário',
      },
      filename: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'Nome do arquivo salvo em disco',
      },
      filetype: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: 'pdf | docx | txt | md',
      },
      filesize: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'Tamanho em bytes',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('processing', 'ready', 'error'),
        defaultValue: 'ready',
      },
    },
    {
      sequelize,
      modelName: 'KnowledgeBase',
      tableName: 'knowledge_bases',
      underscored: true,
      timestamps: true,
      paranoid: true,
    }
  );

  return KnowledgeBase;
};
