import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import App from './App'
import { VenueAdmin } from './components/VenueAdmin'

const router = createBrowserRouter([
  { path: '/', element: <App /> },
  { path: '/dj', element: <VenueAdmin /> },
])

createRoot(document.getElementById('root')!).render(
  <RouterProvider router={router} />
)
