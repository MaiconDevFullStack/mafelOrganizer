/* ============================================================
   admin.js — Painel do Prestador · Mafel (AngularJS)
   ============================================================ */
(function () {
  'use strict';

  angular
    .module('mafelAdmin', ['ngSanitize'])

    /* ── Diretiva onFileChange: sem isolated scope, usa $eval no scope pai ── */
    .directive('onFileChange', function () {
      return {
        restrict: 'A',
        link: function (scope, el, attrs) {
          el.bind('change', function () {
            scope.$apply(function () {
              scope.$eval(attrs.onFileChange, { file: el[0].files[0] || null });
            });
          });
        },
      };
    })

    /* ── Controller principal ───────────────────────────── */
    .controller('AdminController', ['$http', '$timeout', '$filter', '$window',
      function ($http, $timeout, $filter, $window) {
        var vm = this;
        var API = '/api';

        /* ── Auth ────────────────────────────────────────── */
        var _token = $window.localStorage.getItem('mf_token');
        var _role  = $window.localStorage.getItem('mf_role');

        if (!_token) {
          $window.location.href = 'login.html';
          return;
        }
        if (_role === 'admin') {
          // Superadmin não pode usar o painel de prestador
          $window.location.href = 'superadmin.html';
          return;
        }

        // Injeta token em todos os requests
        $http.defaults.headers.common['Authorization'] = 'Bearer ' + _token;

        vm.userName = $window.localStorage.getItem('mf_user_name') || 'Usuário';

        vm.logout = function () {
          $window.localStorage.removeItem('mf_token');
          $window.localStorage.removeItem('mf_role');
          $window.localStorage.removeItem('mf_user_id');
          $window.localStorage.removeItem('mf_user_name');
          $window.localStorage.removeItem('mf_tenant_id');
          $window.localStorage.removeItem('mf_tenant_slug');
          $window.location.href = 'login.html';
        };

        /* ── Estado geral ─────────────────────────────────── */
        vm.tenantSlug   = getTenantSlug();
        vm.tenant       = {};
        vm.section      = 'dashboard';
        vm.globalLoading = false;
        vm.saving       = false;
        vm.modals       = { client: false, pay: false };
        vm.toast        = { visible: false, msg: '', type: 'success' };

        /* Conversas */
        vm.conversations    = [];
        vm.activeConv       = null;
        vm.convMessages     = [];
        vm.convInput        = '';
        vm.convSending      = false;
        vm.convLoading      = false;
        vm.convFilter       = 'open';
        vm.convMobileView   = 'list';
        vm.openConvCount    = 0;
        var _convPollTimer;

        /* Listas */
        vm.kbDocs         = [];
        vm.clients        = [];
        vm.filteredClients = [];
        vm.receivable     = [];
        vm.payable        = [];
        vm.stats          = {};

        /* Filtros */
        vm.clientSearch = '';
        vm.recFilter    = '';
        vm.payFilter    = '';

        /* Formulários */
        vm.kb    = { file: null, description: '', uploading: false, drag: false };
        vm.cForm = {};
        vm.pForm = {};

        /* ── Inicialização ───────────────────────────────── */
        (function init() {
          if (!vm.tenantSlug) {
            notify('Tenant não informado. Acesse /admin.html?tenant=<slug>', 'error');
            return;
          }
          vm.globalLoading = true;
          $http.get(API + '/tenants/' + vm.tenantSlug)
            .then(function (r) {
              vm.tenant = r.data;
            })
            .catch(function () {
              notify('Tenant não encontrado: ' + vm.tenantSlug, 'error');
            })
            .finally(function () {
              vm.globalLoading = false;
              loadAll();
            });
        })();

        function loadAll() {
          loadKb();
          loadClients();
          loadPayments('receivable');
          loadPayments('payable');
          loadStats();
          _refreshConvBadge();
        }

        // Atualiza apenas o contador do badge — chamado no init e a cada 30s
        var _badgeTimer;
        function _refreshConvBadge() {
          if (!vm.tenant || !vm.tenant.id) return;
          $http.get(API + '/conversations', { params: { tenant_id: vm.tenant.id, status: 'open' } })
            .then(function (r) {
              vm.openConvCount = r.data.length;
            })
            .finally(function () {
              _badgeTimer = $timeout(_refreshConvBadge, 30000);
            });
        }

        /* ── Navegação ───────────────────────────────────── */
        vm.go = function (sec) {
          vm.section = sec;
          vm.sidebarOpen = false;
          if (sec === 'clients')    loadClients();
          if (sec === 'kb')         loadKb();
          if (sec === 'receivable') loadPayments('receivable');
          if (sec === 'payable')    loadPayments('payable');
          if (sec === 'dashboard')  { loadAll(); }
          if (sec === 'conversations') vm.loadConversations();
          if (sec === 'profile')    vm.loadProfile();
        };

        vm.sectionTitle = function () {
          var map = {
            dashboard:     'Dashboard',
            kb:            'Base de Conhecimento',
            clients:       'Clientes',
            conversations: 'Conversas',
            receivable:    'Contas a Receber',
            payable:       'Contas a Pagar',
            profile:       'Meu Perfil',
          };
          return map[vm.section] || '';
        };

        /* ── Base de Conhecimento ────────────────────────── */
        function loadKb() {
          $http.get(API + '/kb', { params: { tenant_id: vm.tenant.id } })
            .then(function (r) { vm.kbDocs = r.data; });
        }

        // Chamado pela diretiva on-file-change — já dentro do digest cycle
        vm.handleFileChange = function (file) {
          vm.kb.file = file || null;
        };

        vm.clearFile = function () {
          vm.kb.file = null;
          var input = document.getElementById('kbFile');
          if (input) input.value = '';
        };

        vm.uploadKb = function () {
          if (!vm.kb.file) return;
          if (!vm.tenant || !vm.tenant.id) {
            notify('Tenant ainda não carregado. Aguarde ou recarregue a página.', 'error');
            return;
          }
          vm.kb.uploading = true;

          var fd = new FormData();
          fd.append('file', vm.kb.file);
          fd.append('tenant_id', vm.tenant.id);
          if (vm.kb.description) fd.append('description', vm.kb.description);

          $http.post(API + '/kb/upload', fd, {
            headers: { 'Content-Type': undefined },
            transformRequest: angular.identity,
          })
            .then(function (r) {
              vm.kbDocs.unshift(r.data);
              vm.kb.file = null;
              vm.kb.description = '';
              var input = document.getElementById('kbFile');
              if (input) input.value = '';
              notify('Documento enviado com sucesso!', 'success');
              loadStats();
            })
            .catch(function (e) {
              notify(e.data && e.data.error ? e.data.error : 'Erro ao enviar arquivo.', 'error');
            })
            .finally(function () { vm.kb.uploading = false; });
        };

        vm.deleteKb = function (doc) {
          if (!confirm('Remover o documento "' + doc.original_name + '"?')) return;
          $http.delete(API + '/kb/' + doc.id)
            .then(function () {
              vm.kbDocs = vm.kbDocs.filter(function (d) { return d.id !== doc.id; });
              notify('Documento removido.', 'info');
            })
            .catch(function () { notify('Erro ao remover documento.', 'error'); });
        };

        vm.fmtSize = function (bytes) {
          if (!bytes) return '0 B';
          if (bytes < 1024) return bytes + ' B';
          if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
          return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        };

        /* ── Clientes ────────────────────────────────────── */
        function loadClients() {
          $http.get(API + '/clients', { params: { tenant_id: vm.tenant.id } })
            .then(function (r) {
              vm.clients = r.data;
              vm.filteredClients = r.data;
            });
        }

        vm.filterClients = function () {
          if (!vm.clientSearch) {
            vm.filteredClients = vm.clients;
            return;
          }
          var q = vm.clientSearch.toLowerCase();
          vm.filteredClients = vm.clients.filter(function (c) {
            return (c.name  || '').toLowerCase().includes(q) ||
                   (c.email || '').toLowerCase().includes(q) ||
                   (c.phone || '').toLowerCase().includes(q);
          });
        };

        vm.openClientModal = function (client) {
          vm.cForm = client
            ? angular.copy(client)
            : { tenant_id: vm.tenant.id, is_active: true };
          vm.modals.client = true;
        };

        vm.saveClient = function () {
          if (!vm.cForm.name) { notify('Nome é obrigatório.', 'error'); return; }
          vm.saving = true;

          var req = vm.cForm.id
            ? $http.patch(API + '/clients/' + vm.cForm.id, vm.cForm)
            : $http.post(API + '/clients', vm.cForm);

          req
            .then(function (r) {
              if (vm.cForm.id) {
                var idx = vm.clients.findIndex(function (c) { return c.id === r.data.id; });
                if (idx >= 0) vm.clients[idx] = r.data;
              } else {
                vm.clients.push(r.data);
              }
              vm.filteredClients = vm.clients;
              vm.modals.client = false;
              notify(vm.cForm.id ? 'Cliente atualizado!' : 'Cliente criado!', 'success');
              loadStats();
            })
            .catch(function (e) {
              notify(e.data && e.data.error ? e.data.error : 'Erro ao salvar cliente.', 'error');
            })
            .finally(function () { vm.saving = false; });
        };

        vm.deleteClient = function (c) {
          if (!confirm('Remover o cliente "' + c.name + '"?')) return;
          $http.delete(API + '/clients/' + c.id)
            .then(function () {
              vm.clients = vm.clients.filter(function (x) { return x.id !== c.id; });
              vm.filteredClients = vm.clients;
              notify('Cliente removido.', 'info');
              loadStats();
            })
            .catch(function () { notify('Erro ao remover cliente.', 'error'); });
        };

        /* ── Autocomplete de clientes no modal de pagamento ────── */
        vm.clientQuery = '';
        vm.acList      = [];
        vm.showAc      = false;

        vm.onClientQueryChange = function () {
          var q = (vm.clientQuery || '').toLowerCase().trim();
          if (!q) { vm.acList = []; vm.showAc = false; return; }
          vm.acList = vm.clients.filter(function (c) {
            return (c.name  || '').toLowerCase().includes(q) ||
                   (c.email || '').toLowerCase().includes(q) ||
                   (c.phone || '').toLowerCase().includes(q);
          }).slice(0, 8);
          vm.showAc = vm.acList.length > 0;
        };

        vm.selectAcClient = function (c) {
          vm.pForm.client_name  = c.name;
          vm.pForm.client_email = c.email || '';
          vm.pForm.client_phone = c.phone || '';
          vm.clientQuery        = c.name;
          vm.showAc             = false;
        };

        vm.closeAc = function () {
          $timeout(function () { vm.showAc = false; }, 180);
        };

        /* ── Pagamentos ──────────────────────────────────── */
        vm.loadPayments = function (type) {
          loadPayments(type);
        };

        function loadPayments(type) {
          var filter = type === 'receivable' ? vm.recFilter : vm.payFilter;
          var params = { tenant_id: vm.tenant.id, type: type };
          if (filter) params.status = filter;

          $http.get(API + '/payments/schedules', { params: params })
            .then(function (r) {
              if (type === 'receivable') vm.receivable = r.data;
              else                        vm.payable   = r.data;
            });
        }

        function loadStats() {
          if (!vm.tenant.id) return;
          $http.get(API + '/payments/stats', { params: { tenant_id: vm.tenant.id } })
            .then(function (r) { vm.stats = r.data; });
        }

        vm.openPayModal = function (type, schedule) {
          vm.clientQuery = schedule ? (schedule.client_name || '') : '';
          vm.acList      = [];
          vm.showAc      = false;
          vm.pForm = schedule
            ? angular.copy(schedule)
            : {
                tenant_id:      vm.tenant.id,
                type:           type,
                recurrence:     'once',
                payment_method: 'pix',
                currency:       'BRL',
                is_recurring:   false,
              };
          vm.pForm.type = type;
          // Ao editar, marca is_recurring se for mensal com dia definido
          // e normaliza due_date para yyyy-MM-dd (remove hora/fuso)
          if (schedule) {
            vm.pForm.is_recurring = (schedule.recurrence === 'monthly' && !!schedule.recurring_day);
            if (vm.pForm.due_date && typeof vm.pForm.due_date === 'string') {
              vm.pForm.due_date = vm.pForm.due_date.substring(0, 10);
            }
          }
          vm.modals.pay = true;
        };

        vm.savePay = function () {
          /* ── Validações ─────────────────────────────── */
          if (!vm.pForm.client_name || !vm.pForm.client_name.trim()) {
            notify('Nome do cliente é obrigatório.', 'error'); return;
          }
          if (!vm.pForm.amount || vm.pForm.amount <= 0) {
            notify('Informe um valor válido maior que zero.', 'error'); return;
          }

          /* ── Data: recorrente (dia do mês) ou data completa ── */
          if (vm.pForm.is_recurring) {
            var rd = parseInt(vm.pForm.recurring_day, 10);
            if (!rd || rd < 1 || rd > 31) {
              notify('Informe um dia válido para a recorrência (1 a 31).', 'error'); return;
            }
            // Calcula próximo vencimento a partir de hoje
            var now  = new Date();
            var next = new Date(now.getFullYear(), now.getMonth(), rd);
            if (next <= now) {
              next = new Date(now.getFullYear(), now.getMonth() + 1, rd);
            }
            vm.pForm.due_date   = next.getFullYear() + '-' +
                                   String(next.getMonth() + 1).padStart(2, '0') + '-' +
                                   String(next.getDate()).padStart(2, '0');
            vm.pForm.recurrence = 'monthly';
          } else {
            if (!vm.pForm.due_date) {
              notify('A data de vencimento é obrigatória.', 'error'); return;
            }
            if (typeof vm.pForm.due_date !== 'string') {
              vm.pForm.due_date = $filter('date')(vm.pForm.due_date, 'yyyy-MM-dd');
            }
          }

          vm.saving = true;
          var payload = angular.copy(vm.pForm);
          delete payload.is_recurring; // campo apenas de UI

          var isEdit = !!payload.id;
          var req = isEdit
            ? $http.patch(API + '/payments/schedules/' + payload.id, payload)
            : $http.post(API + '/payments/schedules', payload);

          req
            .then(function (r) {
              var type = payload.type || r.data.type;
              if (isEdit) {
                var arr = type === 'receivable' ? vm.receivable : vm.payable;
                var idx = arr.findIndex(function (s) { return s.id === r.data.id; });
                if (idx >= 0) arr[idx] = r.data;
              } else {
                if (type === 'receivable') vm.receivable.push(r.data);
                else                        vm.payable.push(r.data);
              }
              vm.modals.pay = false;
              notify('Lançamento salvo com sucesso!', 'success');
              loadStats();
            })
            .catch(function (e) {
              notify(e.data && e.data.error ? e.data.error : 'Erro ao salvar.', 'error');
            })
            .finally(function () { vm.saving = false; });
        };

        vm.executeSchedule = function (s) {
          var label = s.type === 'receivable' ? 'Confirma execução da cobrança?' : 'Marcar como pago?';
          if (!confirm(label)) return;
          $http.post(API + '/payments/schedules/' + s.id + '/execute')
            .then(function (r) {
              notify(r.data.status === 'success' ? 'Operação realizada com sucesso!' : 'Falha na operação.', r.data.status === 'success' ? 'success' : 'error');
              loadPayments(s.type);
              loadStats();
            })
            .catch(function () { notify('Erro ao executar.', 'error'); });
        };

        vm.cancelSchedule = function (s) {
          if (!confirm('Cancelar este lançamento?')) return;
          $http.patch(API + '/payments/schedules/' + s.id, { status: 'cancelled' })
            .then(function () {
              s.status = 'cancelled';
              notify('Lançamento cancelado.', 'info');
              loadStats();
            })
            .catch(function () { notify('Erro ao cancelar.', 'error'); });
        };

        vm.notifyWhatsApp = function (s) {
          if (!s.client_phone) {
            notify('Cliente sem telefone cadastrado.', 'error'); return;
          }
          var label = 'Enviar lembrete de cobrança via WhatsApp para ' + s.client_name + ' (' + s.client_phone + ')?';
          if (!confirm(label)) return;
          $http.post(API + '/whatsapp/notify/payment', { schedule_id: s.id })
            .then(function (r) {
              if (r.data.simulated) {
                notify('Simulado (WhatsApp não configurado): mensagem gerada no log.', 'info');
              } else {
                notify('Lembrete enviado via WhatsApp!', 'success');
              }
            })
            .catch(function (e) {
              notify(e.data && e.data.error ? e.data.error : 'Erro ao enviar WhatsApp.', 'error');
            });
        };

        /* ── Helpers de formatação ───────────────────────── */
        vm.isOverdue = function (s) {
          if (s.status !== 'active') return false;
          var today = new Date().toISOString().split('T')[0];
          return s.due_date < today;
        };

        vm.recLbl = function (r) {
          var map = { once: 'Único', weekly: 'Semanal', monthly: 'Mensal', yearly: 'Anual' };
          return map[r] || r;
        };

        vm.statusLbl = function (s) {
          var map = { active: 'Ativo', paused: 'Pausado', completed: 'Concluído', cancelled: 'Cancelado' };
          return map[s] || s;
        };

        vm.statusCls = function (s) {
          return {
            active:    'label-primary',
            paused:    'label-warning',
            completed: 'label-success',
            cancelled: 'label-default',
          }[s] || 'label-default';
        };

        /* ── Conversas (Inbox) ───────────────────────────── */
        vm.loadConversations = function () {
          var params = { tenant_id: vm.tenant.id };
          if (vm.convFilter !== 'all') params.status = vm.convFilter;
          $http.get(API + '/conversations', { params: params })
            .then(function (r) {
              vm.conversations = r.data;
              vm.openConvCount = r.data.filter(function (c) { return c.status === 'open'; }).length;
            });
        };

        vm.setConvFilter = function (f) {
          vm.convFilter = f;
          vm.loadConversations();
        };

        vm.selectConv = function (conv) {
          vm.activeConv     = conv;
          vm.convMobileView = 'chat';
          vm.convMessages   = [];
          vm.convLoading    = true;
          if (_convPollTimer) $timeout.cancel(_convPollTimer);
          _fetchMessages(conv.id);
        };

        vm.backToList = function () {
          vm.convMobileView = 'list';
          if (_convPollTimer) $timeout.cancel(_convPollTimer);
        };

        function _fetchMessages(convId) {
          $http.get(API + '/conversations/' + convId + '/messages')
            .then(function (r) {
              vm.convMessages = r.data.messages || [];
              vm.convLoading  = false;
              _scrollInbox();
              // polling a cada 5 s enquanto a conversa estiver selecionada
              if (vm.activeConv && vm.activeConv.id === convId) {
                _convPollTimer = $timeout(function () { _fetchMessages(convId); }, 5000);
              }
            })
            .catch(function () { vm.convLoading = false; });
        }

        function _scrollInbox() {
          $timeout(function () {
            var el = document.getElementById('inboxMessages');
            if (el) el.scrollTop = el.scrollHeight;
          }, 60);
        }

        vm.sendHumanMsg = function () {
          var text = (vm.convInput || '').trim();
          if (!text || !vm.activeConv) return;
          vm.convSending = true;
          $http.post(API + '/conversations/' + vm.activeConv.id + '/messages/human', { text: text })
            .then(function (r) {
              vm.convInput = '';
              vm.convMessages.push(r.data);
              // Atualiza preview na lista
              var conv = vm.conversations.find(function (c) { return c.id === vm.activeConv.id; });
              if (conv) {
                if (!conv.messages) conv.messages = [];
                conv.messages.push(r.data);
              }
              _scrollInbox();
            })
            .catch(function (e) {
              notify(e.data && e.data.error ? e.data.error : 'Erro ao enviar mensagem.', 'error');
            })
            .finally(function () { vm.convSending = false; });
        };

        vm.onConvKey = function ($event) {
          if ($event.key === 'Enter' && !$event.shiftKey) {
            $event.preventDefault();
            vm.sendHumanMsg();
          }
        };

        vm.closeConv = function () {
          if (!vm.activeConv) return;
          $http.patch(API + '/conversations/' + vm.activeConv.id, { status: 'closed' })
            .then(function () {
              vm.activeConv.status = 'closed';
              var conv = vm.conversations.find(function (c) { return c.id === vm.activeConv.id; });
              if (conv) conv.status = 'closed';
              vm.openConvCount = Math.max(0, vm.openConvCount - 1);
              notify('Conversa encerrada.', 'info');
            })
            .catch(function () { notify('Erro ao encerrar conversa.', 'error'); });
        };

        vm.initials = function (name) {
          if (!name) return '?';
          return name.split(' ').slice(0, 2).map(function (n) { return n.charAt(0).toUpperCase(); }).join('');
        };

        vm.lastMsg = function (conv) {
          var msgs = conv.messages || [];
          if (!msgs.length) return 'Sem mensagens';
          return msgs[msgs.length - 1].text;
        };

        vm.relTime = function (dt) {
          if (!dt) return '';
          var diff = Math.floor((new Date() - new Date(dt)) / 60000);
          if (diff < 1)    return 'agora';
          if (diff < 60)   return diff + 'min';
          if (diff < 1440) return Math.floor(diff / 60) + 'h';
          return Math.floor(diff / 1440) + 'd';
        };

        /* ── Toast ───────────────────────────────────────── */
        var toastTimer;
        /* ── Perfil do Prestador ──────────────────────── */
        vm.pProfile = {};
        vm.savingProfile = false;

        vm.loadProfile = function () {
          vm.pProfile = angular.copy(vm.tenant);
        };

        vm.saveProfile = function () {
          if (!vm.pProfile.name || !vm.pProfile.name.trim()) {
            notify('Nome da empresa é obrigatório.', 'error'); return;
          }
          if (!vm.pProfile.agent_name || !vm.pProfile.agent_name.trim()) {
            notify('Nome do agente é obrigatório.', 'error'); return;
          }
          vm.savingProfile = true;
          var payload = {
            name:            vm.pProfile.name,
            agent_name:      vm.pProfile.agent_name,
            welcome_message: vm.pProfile.welcome_message,
            primary_color:   vm.pProfile.primary_color,
            logo_url:        vm.pProfile.logo_url,
            background_url:  vm.pProfile.background_url
          };
          $http.patch(API + '/tenants/' + vm.tenant.id, payload)
            .then(function (r) {
              vm.tenant = r.data;
              vm.pProfile = angular.copy(r.data);
              notify('Perfil atualizado com sucesso!', 'success');
            })
            .catch(function (e) {
              notify(e.data && e.data.error ? e.data.error : 'Erro ao salvar perfil.', 'error');
            })
            .finally(function () { vm.savingProfile = false; });
        };

        vm.chatPublicUrl = function () {
          var slug = vm.tenant && vm.tenant.agent_slug ? vm.tenant.agent_slug : '';
          return window.location.origin + '/chat/' + slug;
        };

        vm.copyChatUrl = function () {
          var url = vm.chatPublicUrl();
          if (navigator.clipboard) {
            navigator.clipboard.writeText(url).then(function () {
              notify('Link copiado!', 'success');
            });
          } else {
            var el = document.createElement('textarea');
            el.value = url;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
            notify('Link copiado!', 'success');
          }
        };

        function notify(msg, type) {
          vm.toast = { visible: true, msg: msg, type: type || 'success' };
          if (toastTimer) $timeout.cancel(toastTimer);
          toastTimer = $timeout(function () {
            vm.toast.visible = false;
          }, 3500);
        }

        /* ── Utilitários ─────────────────────────────────── */
        function getTenantSlug() {
          var m = window.location.search.match(/[?&]tenant=([^&]+)/);
          return m ? decodeURIComponent(m[1]) : '';
        }
      },
    ]);

}());
