/* ============================================================
   superadmin.js — Painel Super Admin · Mafel (AngularJS)
   ============================================================ */
(function () {
  'use strict';

  angular
    .module('mafelSuperAdmin', ['ngSanitize'])
    .controller('SuperAdminController', ['$http', '$timeout', '$window',
      function ($http, $timeout, $window) {
        var vm = this;
        var API = '/api';

        /* ── Auth ────────────────────────────────────────── */
        var _token = $window.localStorage.getItem('mf_token');
        var _role  = $window.localStorage.getItem('mf_role');

        if (!_token || _role !== 'admin') {
          $window.location.href = 'login.html';
          return;
        }

        // Injeta token em todos os requests
        $http.defaults.headers.common['Authorization'] = 'Bearer ' + _token;

        vm.userName = $window.localStorage.getItem('mf_user_name') || 'Super Admin';

        vm.logout = function () {
          $window.localStorage.removeItem('mf_token');
          $window.localStorage.removeItem('mf_role');
          $window.localStorage.removeItem('mf_user_id');
          $window.localStorage.removeItem('mf_user_name');
          $window.location.href = 'login.html';
        };

        /* ── Estado ──────────────────────────────────────── */
        vm.section      = 'dashboard';
        vm.globalLoading = false;
        vm.saving       = false;
        vm.modal        = false;
        vm.tab          = 'info';
        vm.toast        = { visible: false, msg: '', type: 'success' };

        vm.providers  = [];
        vm.filtered   = [];
        vm.statsMap   = {};

        vm.search       = '';
        vm.filterStatus = '';
        vm.form         = {};
        vm.errors       = {};

        /* ── Init ────────────────────────────────────────── */
        (function init() {
          loadAll();
        })();

        function loadAll() {
          vm.globalLoading = true;
          $http.get(API + '/tenants', { params: { all: 'true' } })
            .then(function (r) {
              vm.providers = r.data;
              vm.filterProviders();
              return $http.get(API + '/tenants/stats');
            })
            .then(function (r) {
              r.data.forEach(function (s) { vm.statsMap[s.id] = s; });
            })
            .catch(function (e) {
              notify(e.data && e.data.error ? e.data.error : 'Erro ao carregar prestadores.', 'error');
            })
            .finally(function () { vm.globalLoading = false; });
        }

        /* ── Navegação ───────────────────────────────────── */
        vm.go = function (sec) {
          vm.section = sec;
          vm.sidebarOpen = false;
        };

        vm.sectionTitle = function () {
          return { dashboard: 'Dashboard', providers: 'Prestadores de Serviço' }[vm.section] || '';
        };

        /* ── Filtro ──────────────────────────────────────── */
        vm.filterProviders = function () {
          var q = (vm.search || '').toLowerCase();
          vm.filtered = vm.providers.filter(function (p) {
            var matchText = !q ||
              p.name.toLowerCase().includes(q) ||
              p.slug.toLowerCase().includes(q) ||
              (p.agent_name || '').toLowerCase().includes(q);
            var matchStatus =
              vm.filterStatus === '' ||
              (vm.filterStatus === 'active'   &&  p.is_active) ||
              (vm.filterStatus === 'inactive' && !p.is_active);
            return matchText && matchStatus;
          });
        };

        /* ── Stats helpers ───────────────────────────────── */
        vm.statsFor = function (id) { return vm.statsMap[id] || {}; };

        vm.activeCount   = function () { return vm.providers.filter(function (p) { return  p.is_active; }).length; };
        vm.inactiveCount = function () { return vm.providers.filter(function (p) { return !p.is_active; }).length; };
        vm.planCount     = function (plan) { return vm.providers.filter(function (p) { return p.plan === plan; }).length; };
        vm.planPct       = function (plan) {
          if (!vm.providers.length) return 0;
          return Math.round(vm.planCount(plan) / vm.providers.length * 100);
        };
        vm.totalClients = function () {
          return Object.values(vm.statsMap).reduce(function (acc, s) { return acc + (s.clients || 0); }, 0);
        };

        /* ── Labels / classes ────────────────────────────── */
        vm.planLbl = function (p) {
          return { basic: 'Basic', professional: 'Professional', enterprise: 'Enterprise' }[p] || p;
        };
        vm.planCls = function (p) {
          return { basic: 'label-primary', professional: 'label-info', enterprise: 'label-warning' }[p] || 'label-default';
        };

        /* ── URL personalizada do chat ─────────────────── */
        vm.chatUrl = function (p) {
          return p.agent_slug ? '/chat/' + p.agent_slug : '/?tenant=' + p.slug;
        };

        vm.copyUrl = function (p) {
          var url = window.location.origin + vm.chatUrl(p);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function () {
              notify('URL copiada: ' + url, 'success');
            });
          } else {
            // Fallback para browsers sem clipboard API
            var el = document.createElement('textarea');
            el.value = url;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
            notify('URL copiada: ' + url, 'success');
          }
        };

        /* ── Modal ───────────────────────────────────────── */
        vm.openModal = function (provider) {
          vm.errors = {};
          vm.tab    = 'info';
          vm.form   = provider
            ? angular.copy(provider)
            : { plan: 'basic', primary_color: '#2563eb', is_active: true,
                agent_name: 'Assistente', welcome_message: 'Olá! Como posso ajudar?' };
          vm.modal  = true;
        };

        vm.sanitizeSlug = function () {
          if (vm.form.slug) {
            vm.form.slug = vm.form.slug
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^a-z0-9-]/g, '');
          }
        };

        vm.save = function () {
          vm.errors = {};

          if (!vm.form.name || vm.form.name.trim().length < 2) {
            vm.errors.name = 'Nome deve ter ao menos 2 caracteres.';
            vm.tab = 'info';
            return;
          }
          if (!vm.form.id) {
            if (!vm.form.slug || vm.form.slug.trim().length < 2) {
              vm.errors.slug = 'Slug é obrigatório.';
              vm.tab = 'info';
              return;
            }
          }

          vm.saving = true;

          var req = vm.form.id
            ? $http.patch(API + '/tenants/' + vm.form.id, vm.form)
            : $http.post(API + '/tenants', vm.form);

          req
            .then(function (r) {
              if (vm.form.id) {
                var idx = vm.providers.findIndex(function (p) { return p.id === r.data.id; });
                if (idx >= 0) vm.providers[idx] = r.data;
              } else {
                vm.providers.unshift(r.data);
              }
              vm.filterProviders();
              vm.modal = false;
              notify(vm.form.id ? 'Prestador atualizado!' : 'Prestador criado com sucesso!', 'success');
              // Atualiza stats se novo
              if (!vm.form.id) loadStats();
            })
            .catch(function (e) {
              var msg = e.data && e.data.error ? e.data.error : 'Erro ao salvar.';
              if (msg.toLowerCase().includes('slug')) {
                vm.errors.slug = msg;
                vm.tab = 'info';
              }
              notify(msg, 'error');
            })
            .finally(function () { vm.saving = false; });
        };

        /* ── Toggle ativo/inativo ────────────────────────── */
        vm.toggleActive = function (p) {
          var acao = p.is_active ? 'desativar' : 'ativar';
          if (!confirm('Deseja ' + acao + ' o prestador "' + p.name + '"?')) return;
          $http.patch(API + '/tenants/' + p.id, { is_active: !p.is_active })
            .then(function (r) {
              var idx = vm.providers.findIndex(function (x) { return x.id === p.id; });
              if (idx >= 0) vm.providers[idx] = r.data;
              vm.filterProviders();
              notify('Prestador ' + (r.data.is_active ? 'ativado' : 'desativado') + '.', 'info');
            })
            .catch(function () { notify('Erro ao atualizar status.', 'error'); });
        };

        /* ── Delete (desativa permanente via API) ────────── */
        vm.deleteProvider = function (p) {
          if (!confirm('Excluir permanentemente o prestador "' + p.name + '"?\n\nEsta ação não pode ser desfeita.')) return;
          $http.delete(API + '/tenants/' + p.id)
            .then(function () {
              vm.providers = vm.providers.filter(function (x) { return x.id !== p.id; });
              vm.filterProviders();
              notify('Prestador excluído.', 'info');
            })
            .catch(function () { notify('Erro ao excluir prestador.', 'error'); });
        };

        /* ── Stats reload ────────────────────────────────── */
        function loadStats() {
          $http.get(API + '/tenants/stats')
            .then(function (r) {
              vm.statsMap = {};
              r.data.forEach(function (s) { vm.statsMap[s.id] = s; });
            });
        }

        /* ── Toast ───────────────────────────────────────── */
        var toastTimer;
        function notify(msg, type) {
          vm.toast = { visible: true, msg: msg, type: type || 'success' };
          if (toastTimer) $timeout.cancel(toastTimer);
          toastTimer = $timeout(function () { vm.toast.visible = false; }, 3500);
        }
      },
    ]);
}());
