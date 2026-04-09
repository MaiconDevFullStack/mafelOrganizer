'use strict';
/**
 * scripts/seed-superadmin.js
 * Cria (ou atualiza) o usuário superadmin no banco.
 * Uso local:  node scripts/seed-superadmin.js
 * Uso Railway: adicione como variável de ambiente e rode via painel ou
 *              inclua no start command temporariamente.
 */

require('dotenv').config();
const bcrypt    = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { sequelize } = require('../src/models');
const { QueryInterface, DataTypes } = require('sequelize');

const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || 'maicon@mafelsoft.com.br';
const SUPERADMIN_PASS  = process.env.SUPERADMIN_PASS  || 'felipe01';
const SUPERADMIN_NAME  = process.env.SUPERADMIN_NAME  || 'Maicon Superadmin';

(async () => {
  try {
    await sequelize.authenticate();
    console.log('✅  Banco conectado.');

    // Garante que a tabela existe
    await sequelize.sync();

    const { User } = require('../src/models');

    const hash = await bcrypt.hash(SUPERADMIN_PASS, 10);

    const [user, created] = await User.findOrCreate({
      where: { email: SUPERADMIN_EMAIL.toLowerCase() },
      defaults: {
        id:            uuidv4(),
        name:          SUPERADMIN_NAME,
        email:         SUPERADMIN_EMAIL.toLowerCase(),
        password_hash: hash,
        role:          'admin',
        tenant_id:     null,
        is_active:     true,
      },
    });

    if (!created) {
      // Atualiza a senha e garante role admin caso já exista
      await user.update({
        password_hash: hash,
        role:          'admin',
        is_active:     true,
      });
      console.log(`♻️   Superadmin atualizado: ${SUPERADMIN_EMAIL}`);
    } else {
      console.log(`✅  Superadmin criado: ${SUPERADMIN_EMAIL}`);
    }

    console.log('   role:      admin');
    console.log('   tenant_id: null (acesso global)');
    console.log('   Acesse:    /login-superadmin.html');

    process.exit(0);
  } catch (err) {
    console.error('❌  Erro:', err.message);
    process.exit(1);
  }
})();
