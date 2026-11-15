import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import './App.css'

const menuItems = [
  { name: 'Overview', icon: '▦' },
  { name: 'Sales', icon: '₹' },
  { name: 'Inventory', icon: '◇' },
  { name: 'Expenses', icon: '↗' },
  { name: 'Customers', icon: '♙' },
  { name: 'Reports', icon: '▥' },
  { name: 'Profile', icon: '◎' },
  { name: 'Team Management', icon: '♙' }
]

const products = [
  { name: '500 ML Water', detail: '24 bottles per carton' },
  { name: '1 Litre Water', detail: '12 bottles per carton' }
]

function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [activePage, setActivePage] = useState('Overview')

  const [loading, setLoading] = useState(true)
  const [connectionStatus, setConnectionStatus] = useState('Checking...')
  const [authMode, setAuthMode] = useState('login')

  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [team, setTeam] = useState([])
  const [teamLoading, setTeamLoading] = useState(false)

  const today = new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata'
  }).format(new Date())

  // LOAD PROFILE

  async function loadProfile(user) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (error) {
      console.error('Profile loading error:', error.message)
      setProfile(null)
      setError('Unable to load your profile. Please contact the owner.')
      return
    }

    setProfile(data)
    setError('')
  }

  // CHECK AUTHENTICATION

  useEffect(() => {
    let mounted = true

    async function initialize() {
      try {
        const { data, error } = await supabase.auth.getSession()

        if (error) throw error

        if (data.session && mounted) {
          setSession(data.session)
          await loadProfile(data.session.user)
        }
      } catch (err) {
        console.error(err.message)
      } finally {
        if (mounted) setLoading(false)
      }
    }

    initialize()

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (!mounted) return

      setSession(newSession)

      if (event === 'SIGNED_OUT') {
        setProfile(null)
        setActivePage('Overview')
      }

      if (newSession && event === 'SIGNED_IN') {
        setTimeout(() => {
          if (mounted) loadProfile(newSession.user)
        }, 0)
      }
    })

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

  // CONNECTION CHECK

  useEffect(() => {
    async function checkConnection() {
      try {
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/auth/v1/health`,
          {
            headers: {
              apikey:
                import.meta.env.VITE_SUPABASE_ANON_KEY ||
                import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
            }
          }
        )

        setConnectionStatus(
          response.ok ? 'Connected' : 'Disconnected'
        )
      } catch {
        setConnectionStatus('Disconnected')
      }
    }

    checkConnection()
  }, [])

  // LOGIN

  async function handleLogin(e) {
    e.preventDefault()
    setError('')
    setMessage('')

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password
      })

      if (error) throw error

      setMessage('Login successful. Loading your dashboard...')
    } catch (err) {
      setError(err.message)
    }
  }

  // REGISTRATION

  async function handleSignup(e) {
    e.preventDefault()
    setError('')
    setMessage('')

    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName.trim()
          },
          emailRedirectTo: window.location.origin
        }
      })

      if (error) throw error

      if (data.session) {
        setMessage('Account created. Please wait for owner approval.')
      } else {
        setMessage(
          'Registration successful! Verify your email, then wait for owner approval.'
        )
      }

      setAuthMode('login')
      setPassword('')
    } catch (err) {
      setError(err.message)
    }
  }

  // PROFILE PICTURE UPLOAD

async function handleAvatarUpload(e) {
  const file = e.target.files?.[0]
  if (!file) return

  if (!file.type.startsWith('image/')) {
    alert('Please select an image.')
    return
  }

  if (file.size > 5 * 1024 * 1024) {
    alert('Image must be smaller than 5 MB.')
    return
  }

  try {
    const filePath = `${session.user.id}/${Date.now()}-${file.name}`

    const { error: uploadError } = await supabase.storage
      .from('profile-picture')
      .upload(filePath, file)

    if (uploadError) throw uploadError

    const { data } = supabase.storage
      .from('profile-picture')
      .getPublicUrl(filePath)

    const { error: updateError } = await supabase.rpc(
      'update_my_avatar',
      { image_url: data.publicUrl }
    )

    if (updateError) throw updateError

    setProfile(prev => ({
      ...prev,
      avatar_url: data.publicUrl
    }))

    alert('Profile picture updated successfully!')
  } catch (error) {
    alert(error.message)
  }

  e.target.value = ''
}
  
  // LOGOUT

  async function handleLogout() {
    const { error } = await supabase.auth.signOut()

    if (error) {
      setError(error.message)
    } else {
      setSession(null)
      setProfile(null)
    }
  }

  // OWNER: LOAD TEAM

  async function loadTeam() {
    setTeamLoading(true)
    setError('')

    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, status, created_at')
      .eq('role', 'salesperson')
      .order('created_at', { ascending: false })

    if (error) {
      setError(error.message)
    } else {
      setTeam(data || [])
    }

    setTeamLoading(false)
  }

  useEffect(() => {
    if (
      profile?.role === 'owner' &&
      profile?.status === 'approved' &&
      activePage === 'Team Management'
    ) {
      loadTeam()
    }
  }, [profile, activePage])

  // OWNER: APPROVE / DISABLE

  async function updateSalesperson(id, status) {
    setError('')

    const { error } = await supabase
      .from('profiles')
      .update({ status })
      .eq('id', id)
      .eq('role', 'salesperson')

    if (error) {
      setError(error.message)
      return
    }

    await loadTeam()
  }

  // LOADING SCREEN

  if (loading) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>ETHEREAL</h1>
          <p>Loading Business Manager...</p>
        </div>
      </div>
    )
  }

  // AUTHENTICATION SCREEN

  if (!session) {
    return (
      <div className="auth-screen">
        <div className="auth-card">

          <div className="auth-brand">
            <div>ETHEREAL</div>
            <span>Co.</span>
            <p>PURE BY NATURE · SAFE FOR LIFE</p>
          </div>

          <h2>
            {authMode === 'login'
              ? 'Welcome Back'
              : 'Join Ethereal Co.'}
          </h2>

          <p className="auth-description">
            {authMode === 'login'
              ? 'Sign in to manage your business.'
              : 'Create your salesperson account.'}
          </p>

          <form
            onSubmit={
              authMode === 'login'
                ? handleLogin
                : handleSignup
            }
          >

            {authMode === 'signup' && (
              <div className="form-group">
                <label>Full Name</label>
                <input
                  type="text"
                  value={fullName}
                  onChange={e => setFullName(e.target.value)}
                  placeholder="Enter your full name"
                  required
                />
              </div>
            )}

            <div className="form-group">
              <label>Email Address</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="Enter your email"
                required
              />
            </div>

            <div className="form-group">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter password"
                minLength={8}
                required
              />
            </div>

            {error && (
              <div className="auth-error">{error}</div>
            )}

            {message && (
              <div className="auth-success">{message}</div>
            )}

            <button className="auth-submit" type="submit">
              {authMode === 'login'
                ? 'Sign In'
                : 'Create Account'}
            </button>

          </form>

          <div className="auth-switch">
            {authMode === 'login' ? (
              <>
                New salesperson?
                <button onClick={() => {
                  setAuthMode('signup')
                  setError('')
                  setMessage('')
                }}>
                  Register
                </button>
              </>
            ) : (
              <>
                Already registered?
                <button onClick={() => {
                  setAuthMode('login')
                  setError('')
                  setMessage('')
                }}>
                  Sign In
                </button>
              </>
            )}
          </div>

          <div className="auth-footer">
            ETHEREAL CO. © 2026
          </div>

        </div>
      </div>
    )
  }

  // ACCOUNT STATUS

  if (!profile) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h2>Profile unavailable</h2>
          <p>{error || 'Your profile could not be loaded.'}</p>
          <button className="auth-submit" onClick={handleLogout}>
            Sign Out
          </button>
        </div>
      </div>
    )
  }

  if (profile.status === 'pending') {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-brand">
            <div>ETHEREAL</div>
            <span>Co.</span>
          </div>

          <h2>Approval Pending</h2>

          <p className="auth-description">
            Hello {profile.full_name}, your registration is
            awaiting approval from the business owner.
          </p>

          <div className="status-message">
            Your account is registered but access has not
            yet been approved.
          </div>

          <button className="auth-submit" onClick={handleLogout}>
            Sign Out
          </button>
        </div>
      </div>
    )
  }

  if (profile.status !== 'approved') {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h2>Account Disabled</h2>
          <p className="auth-description">
            Your account access has been disabled.
            Please contact the owner.
          </p>
          <button className="auth-submit" onClick={handleLogout}>
            Sign Out
          </button>
        </div>
      </div>
    )
  }

  // MAIN DASHBOARD

  const isOwner = profile.role === 'owner'

  return (
    <div className="app-shell">

      <aside className="sidebar">

        <div className="brand-lockup">
          <div className="brand-trees">♠ ♠ ♠</div>
          <div className="brand-name">ETHEREAL</div>
          <div className="brand-co">Co.</div>
          <div className="brand-rule" />
          <div className="brand-subtitle">BUSINESS MANAGER</div>
        </div>

        <div className="nav-label">MAIN MENU</div>

        <nav className="sidebar-nav">
          {menuItems
            .filter(item =>
              item.name !== 'Team Management' || isOwner
            )
            .map(item => (
              <button
                key={item.name}
                className={`nav-item ${
                  activePage === item.name ? 'active' : ''
                }`}
                onClick={() => setActivePage(item.name)}
              >
                <span className="nav-icon">{item.icon}</span>
                <span>{item.name}</span>
              </button>
            ))}
        </nav>

        <div className="sidebar-art" />

        <div className="sidebar-tagline">
          PURE BY NATURE<br />
          SAFE FOR LIFE
        </div>

        <div className="sidebar-tagline-rule" />

        <div className="sidebar-profile">
          <div className="profile-avatar">
            {profile.full_name?.charAt(0).toUpperCase()}
          </div>

          <div>
            <strong>{profile.full_name}</strong>
            <span>{profile.role === 'owner' ? 'Owner' : 'Salesperson'}</span>
          </div>
        </div>

      </aside>

      <main className="main-area">

        <header className="topbar">

          <div className="topbar-title">
            <h2>{activePage}</h2>
            <p>Welcome to Ethereal Business Manager</p>
          </div>

          <div className="topbar-actions">

            <span className={`connection-dot ${
              connectionStatus === 'Connected' ? 'is-online' : ''
            }`} />

            <span className="connection-text">
              {connectionStatus}
            </span>

            <div className="top-avatar">
              {profile.full_name?.charAt(0).toUpperCase()}
            </div>

            <button
              className="logout-button"
              onClick={handleLogout}
            >
              Logout
            </button>

          </div>

        </header>

        {activePage === 'Overview' ? (

          <div className="dashboard-content">

            <section className="hero-banner">
              <img
                src="/assets/ethereal-hero.png"
                alt="Ethereal Co. mountain and lake"
              />
            </section>

            <section className="stats-grid">

              {[
                ["Today's Sales", '₹0.00', 'Total sales today', '₹', 'green'],
                ['Amount Collected', '₹0.00', 'Payments received today', '↓', 'blue'],
                ['Outstanding', '₹0.00', 'Pending customer payments', '!', 'orange'],
                ['Transactions', '0', 'Sales recorded today', '#', 'green']
              ].map(stat => (
                <article className="stat-card" key={stat[0]}>
                  <div className={`stat-icon ${stat[4]}`}>
                    {stat[3]}
                  </div>
                  <div className="stat-copy">
                    <span className="stat-title">{stat[0]}</span>
                    <strong>{stat[1]}</strong>
                    <small>{stat[2]}</small>
                  </div>
                </article>
              ))}

            </section>

            <section className="section-block">

              <div className="section-heading">
                <div>
                  <h3>Inventory Overview</h3>
                  <p>Current available stock</p>
                </div>

                <button
                  className="link-button"
                  onClick={() => setActivePage('Inventory')}
                >
                  View Inventory →
                </button>
              </div>

              <div className="inventory-grid">

                {products.map(product => (
                  <article className="inventory-card" key={product.name}>
                    <div className="bottle-icon">
                      <svg viewBox="0 0 32 58">
                        <path d="M11 3h10v7l4 5v34a5 5 0 0 1-5 5H12a5 5 0 0 1-5-5V15l4-5z" />
                        <path d="M11 10h10M8 18h16" />
                      </svg>
                    </div>

                    <div className="product-copy">
                      <strong>{product.name}</strong>
                      <span>{product.detail}</span>
                    </div>

                    <div className="inventory-divider" />

                    <div className="stock-value">
                      <strong>0</strong>
                      <span>Cartons in stock</span>
                    </div>

                    <div className="inventory-mountain" />

                    <div className="inventory-footer">
                      ◇ <span>Sold today: 0 cartons</span>
                    </div>
                  </article>
                ))}

              </div>
            </section>

            <section className="section-block transactions-section">

              <div className="section-heading">
                <div>
                  <h3>Today's Transactions</h3>
                  <p>Sales recorded on {today}</p>
                </div>

                <button
                  className="link-button"
                  onClick={() => setActivePage('Sales')}
                >
                  View All →
                </button>
              </div>

              <div className="transactions-card">
                <div className="table-head">
                  <span>TIME</span>
                  <span>INVOICE</span>
                  <span>CUSTOMER</span>
                  <span>AMOUNT</span>
                  <span>PAYMENT</span>
                </div>

                <div className="empty-transactions">
                  <div className="receipt-icon">▤</div>
                  <strong>No sales recorded today</strong>
                </div>
              </div>

            </section>

            <footer className="page-footer">
              ETHEREAL CO. • PURE BY NATURE, SAFE FOR LIFE
              
            </footer>
                      </div>

        ) : activePage === 'Profile' ? (

          <div className="team-page">
            <div className="section-heading">
              <div>
                <h3>My Profile</h3>
                <p>Your Ethereal Business Manager account details.</p>
              </div>
            </div>

            <div className="transactions-card profile-page-card">
              <div className="profile-picture-section">
                <label className="profile-picture-upload">
                  {profile.avatar_url ? (
                    <img src={profile.avatar_url} alt="Profile" />
                  ) : (
                    <span>{profile.full_name?.charAt(0).toUpperCase()}</span>
                  )}

                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarUpload}
                  />
                </label>
                <p>Click to upload or change your photo</p>
              </div>

              <div className="profile-details">
                <h2>{profile.full_name}</h2>
                <p>{profile.email}</p>

                <div className="profile-detail-row">
                  <span>Account Type</span>
                  <strong>{isOwner ? 'Owner' : 'Salesperson'}</strong>
                </div>

                <div className="profile-detail-row">
                  <span>Account Status</span>
                  <strong>{profile.status}</strong>
                </div>
              </div>
            </div>
          </div>

        ) : activePage === 'Team Management' && isOwner ? (

          <div className="team-page">
            <div className="section-heading">
              <div>
                <h3>Team Management</h3>
                <p>Review and manage salesperson accounts.</p>
              </div>

        
              <button className="link-button" onClick={loadTeam}>
                Refresh ↻
              </button>
            </div>

            {error && <div className="auth-error">{error}</div>}

            {teamLoading ? (
              <p>Loading team members...</p>
            ) : (

              <div className="team-list">

                {team.length === 0 ? (
                  <div className="transactions-card empty-transactions">
                    No salesperson registrations yet.
                  </div>
                ) : (

                  team.map(person => (
                    <div className="team-member" key={person.id}>

                      <div className="profile-avatar">
                        {person.full_name?.charAt(0).toUpperCase()}
                      </div>

                      <div className="team-member-info">
                        <strong>{person.full_name}</strong>
                        <span>{person.email}</span>
                        <small>Status: {person.status}</small>
                      </div>

                      <div className="team-actions">

                        {person.status === 'pending' && (
                          <button
                            onClick={() =>
                              updateSalesperson(person.id, 'approved')
                            }
                          >
                            Approve
                          </button>
                        )}

                        {person.status === 'approved' && (
                          <button
                            className="disable-button"
                            onClick={() =>
                              updateSalesperson(person.id, 'disabled')
                            }
                          >
                            Disable
                          </button>
                        )}

                        {person.status === 'disabled' && (
                          <button
                            onClick={() =>
                              updateSalesperson(person.id, 'approved')
                            }
                          >
                            Re-enable
                          </button>
                        )}

                      </div>

                    </div>
                  ))

                )}

              </div>
            )}

          </div>

        ) : (

          <div className="coming-soon">
            <div className="coming-soon-mark">✦</div>
            <h2>{activePage}</h2>
            <p>This section is ready for the next development step.</p>
            <span>Coming next</span>
          </div>

        )}

      </main>
    </div>
  )
}

export default App